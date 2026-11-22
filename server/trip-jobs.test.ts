import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAccountService } from "./account-routes.ts";
import { createTripPlanStore, type TripPlanStore } from "./trip-plan.ts";
import { createItineraryStore } from "./itinerary.ts";
import { createPackingPlanStore } from "./packing-store.ts";
import { createWardrobeStore } from "./wardrobe.ts";
import { createTripJobs, LEASE_MS } from "./trip-jobs.ts";
import type { GenerateTrip } from "./trip-agent.ts";
import type { GeneratedTripPlan } from "./trip-agent-types.ts";

const PLAN = {
  scenario: "travel",
  placeName: "京都",
  placeDetail: "日本",
  lat: 35.01,
  lon: 135.77,
  startDate: "2026-09-01",
  endDate: "2026-09-01",
  notes: "",
};

function generated(title: string): GeneratedTripPlan {
  const stop = { kind: "spot" as const, name: "祇园", nameEn: "Gion", startTime: "09:00", duration: "1h", note: "步行", noteEn: "Walk", photoQuery: "Gion" };
  return {
    title,
    titleEn: title,
    departLabel: "9.1",
    days: [{
      date: "2026-09-01", dateLabel: "9.1", city: "京都", cityEn: "Kyoto",
      summary: "散步", summaryEn: "Walk", weatherSummary: "晴", weatherSummaryEn: "Sunny",
      weatherRisk: "无", weatherRiskEn: "None",
      outfit: [{ label: "衬衫", labelEn: "Shirt" }, { label: "长裤", labelEn: "Trousers" }],
      equipment: [{ label: "伞", labelEn: "Umbrella" }],
      stops: [stop, stop, stop],
    }],
    packing: {
      summary: "轻装", summaryEn: "Light",
      categories: [{ id: "tops", title: "上装", titleEn: "Tops", items: [{ label: "衬衫", labelEn: "Shirt", quantity: 1, reuse: 1, priority: "core", daysUsed: [1], wardrobeItemId: "" }] }],
      essentials: [{ label: "护照", labelEn: "Passport" }],
    },
  };
}

function setup() {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "wearroute-jobs-")), "t.db"));
  const accounts = createAccountService(db);
  db.prepare(
    `INSERT INTO users (id, email, name, pass_salt, pass_hash) VALUES ('u1', 'a@b.c', 'A', 's', 'h')`
  ).run();
  const tripPlans = createTripPlanStore(db);
  const itinerary = createItineraryStore(db);
  createPackingPlanStore(db);
  const wardrobe = createWardrobeStore(db, join(mkdtempSync(join(tmpdir(), "wearroute-ph-")), "p"));
  let clock = 1_000_000;
  const jobsFor = (generateTrip: GenerateTrip, plans: TripPlanStore = tripPlans) =>
    createTripJobs({
      tripPlans: plans,
      wardrobe,
      userById: (id) => accounts.userById(id),
      generateTrip,
      now: () => clock,
      autoSweep: false,
    });
  return {
    db,
    tripPlans,
    itinerary,
    jobsFor,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

/** A generateTrip whose calls stay pending until released one by one. */
function gate() {
  const waiting: ((plan: GeneratedTripPlan) => void)[] = [];
  const generate: GenerateTrip = () => new Promise((resolve) => waiting.push(resolve));
  return { generate, release: (i: number, title: string) => waiting[i](generated(title)), count: () => waiting.length };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a job orphaned by a restart is taken over and completed", async () => {
  const env = setup();
  const plan = env.tripPlans.save("u1", PLAN);
  // The previous process took the lease, then died before finishing.
  env.tripPlans.startGeneration("u1", plan.id, { token: "dead", leaseMs: env.now() + LEASE_MS });

  const jobs = env.jobsFor(async () => generated("接管后的行程"));
  assert.deepEqual(await jobs.sweep(), [], "a live lease is left alone");
  env.advance(LEASE_MS + 1);
  assert.deepEqual(await jobs.sweep(), [plan.id]);
  await settle();

  const done = env.tripPlans.get("u1", plan.id)!;
  assert.equal(done.generationStatus, "completed");
  assert.equal(env.itinerary.get("u1", done.itineraryId!)?.title, "接管后的行程");
});

test("a job interrupted twice is failed instead of retried forever", async () => {
  const env = setup();
  const plan = env.tripPlans.save("u1", PLAN);
  env.tripPlans.startGeneration("u1", plan.id, { token: "dead", leaseMs: env.now() + LEASE_MS });
  const jobs = env.jobsFor(gate().generate); // the resumed attempt also never returns

  env.advance(LEASE_MS + 1);
  assert.deepEqual(await jobs.sweep(), [plan.id]);
  env.advance(LEASE_MS + 1);
  assert.deepEqual(await jobs.sweep(), []);
  const failed = env.tripPlans.get("u1", plan.id)!;
  assert.equal(failed.generationStatus, "failed");
  assert.match(failed.generationError ?? "", /interrupted/);
});

test("a worker that lost its lease cannot overwrite the new worker's result", async () => {
  const env = setup();
  const plan = env.tripPlans.save("u1", PLAN);
  const agent = gate();
  const jobs = env.jobsFor(agent.generate);
  await jobs.start("u1", plan.id);
  await settle();
  env.advance(LEASE_MS + 1); // e.g. the first instance froze during a deploy
  assert.deepEqual(await jobs.sweep(), [plan.id]);
  await settle();
  assert.equal(agent.count(), 2);

  agent.release(0, "旧结果");
  await settle();
  assert.equal(env.tripPlans.get("u1", plan.id)!.generationStatus, "processing");
  agent.release(1, "新结果");
  await settle();

  const done = env.tripPlans.get("u1", plan.id)!;
  assert.equal(done.generationStatus, "completed");
  assert.equal(env.itinerary.get("u1", done.itineraryId!)?.title, "新结果");
  assert.equal(env.itinerary.list("u1").length, 1, "the stale result left no rows");
});

test("a failure while recording a failure does not crash the server", async (t) => {
  const env = setup();
  const plan = env.tripPlans.save("u1", PLAN);
  const broken: TripPlanStore = {
    ...env.tripPlans,
    markFailed: () => Promise.reject(new Error("database went away")),
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const errors = t.mock.method(console, "error", () => {});

  const jobs = env.jobsFor(() => Promise.reject(new Error("provider down")), broken);
  await jobs.start("u1", plan.id);
  await settle();
  assert.deepEqual(unhandled, []);
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes("could not mark")));
});

test("completion is all-or-nothing", async () => {
  const env = setup();
  const plan = env.tripPlans.save("u1", PLAN);
  // Make the packing insert fail after the itinerary rows were written.
  env.db.exec(`DROP TABLE generated_packing_plans`);
  const jobs = env.jobsFor(async () => generated("不会留下"));
  await jobs.start("u1", plan.id);
  await settle();

  const failed = env.tripPlans.get("u1", plan.id)!;
  assert.equal(failed.generationStatus, "failed");
  assert.equal(failed.itineraryId, null);
  assert.equal(env.itinerary.list("u1").length, 0, "the itinerary insert was rolled back");
});

test("the forecast a plan was made against is kept for change detection", async () => {
  const env = setup();
  const plan = env.tripPlans.save("u1", PLAN);
  const snapshot = { source: "Open-Meteo" as const, available: true, note: "", days: [] };
  const jobs = env.jobsFor(async () => ({ ...generated("有快照"), weatherSnapshot: snapshot }));
  await jobs.start("u1", plan.id);
  await settle();
  assert.deepEqual(env.tripPlans.weatherSnapshot("u1", plan.id), snapshot);
  assert.equal(env.tripPlans.weatherSnapshot("u2", plan.id), null, "scoped to the owner");
});
