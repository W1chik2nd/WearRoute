// The production (PostgreSQL) code paths, end to end. Skipped unless
// TEST_DATABASE_URL points at a disposable database; CI provides one.
// Each run uses its own schema and drops it afterwards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { createPostgresApp, type App } from "./app.ts";
import { createPostgresPool, type PostgresPool } from "./postgres.ts";
import { createPostgresWardrobeStore } from "./postgres-wardrobe.ts";
import { createPostgresTripPlanStore } from "./postgres-trip-plan.ts";
import { createPostgresItineraryStore } from "./postgres-itinerary.ts";
import type { GeneratedTripPlan } from "./trip-agent-types.ts";
import { normalizeGeneratedTrip, type GenerateTrip } from "./trip-agent.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "set TEST_DATABASE_URL to run the PostgreSQL tests";

let app: App;
let server: Server;
let pool: PostgresPool;
let base: string;
const schema = `wearroute_test_${randomBytes(4).toString("hex")}`;
const snapshot = { source: "Open-Meteo" as const, available: true, note: "", days: [] };

const generateTrip: GenerateTrip = async ({ wardrobe }) => {
  const stop = { kind: "spot" as const, name: "祇园", nameEn: "Gion", startTime: "09:00", duration: "1h", note: "步行", noteEn: "Walk", photoQuery: "Gion" };
  const plan: GeneratedTripPlan = {
    title: "京都", titleEn: "Kyoto", departLabel: "9.1",
    days: [{
      date: "2026-09-01", dateLabel: "9.1", city: "京都", cityEn: "Kyoto",
      summary: "散步", summaryEn: "Walk", weatherSummary: "晴", weatherSummaryEn: "Sunny",
      weatherRisk: "无", weatherRiskEn: "None",
      // Wears the owned shirt but "forgets" to pack it.
      outfit: [{ label: "衬衫", labelEn: "Shirt", wardrobeItemId: wardrobe[0]?.id ?? "", kind: "top" }],
      equipment: [{ label: "伞", labelEn: "Umbrella" }],
      stops: [stop, stop, stop],
    }],
    packing: {
      summary: "轻装", summaryEn: "Light",
      categories: [{ id: "equipment", title: "装备", titleEn: "Gear", items: [{ label: "转换插头", labelEn: "Adapter", quantity: 1, reuse: 1, priority: "core", daysUsed: [1], wardrobeItemId: "" }] }],
      essentials: [{ label: "护照", labelEn: "Passport" }],
    },
  };
  // The real agent runs its output through the same checks.
  return { ...normalizeGeneratedTrip(plan, ["2026-09-01"], wardrobe), weatherSnapshot: snapshot };
};

before(async () => {
  if (!url) return;
  process.env.DATABASE_SCHEMA = schema;
  process.env.AI_API_KEY = "test-key-not-used";
  app = await createPostgresApp(url, { generateTrip, autoSweep: false });
  pool = await createPostgresPool(url);
  server = createServer(app.handle);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (!url) return;
  server.close();
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
  await app.close();
  delete process.env.DATABASE_SCHEMA;
  delete process.env.AI_API_KEY;
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function register(email: string) {
  const res = await call("POST", "/api/register", {
    email, password: "correct-horse", name: "Anna", gender: "female", age: 28, heightCm: 168, weightKg: 55,
  });
  assert.equal(res.status, 201);
  return res.body as { token: string; user: { id: string } };
}

test("sessions expire in PostgreSQL too", { skip }, async () => {
  const { token } = await register("pg-session@example.com");
  assert.equal((await call("GET", "/api/me", undefined, token)).status, 200);
  await pool.query(`UPDATE sessions SET expires_at = $1 WHERE token = $2`, [Date.now() - 1, token]);
  assert.equal((await call("GET", "/api/me", undefined, token)).status, 401);
});

test("generation, packing reconciliation, checklist and cascade on PostgreSQL", { skip }, async () => {
  const { token, user } = await register("pg-trip@example.com");
  const wardrobe = createPostgresWardrobeStore(pool);
  const shirt = await wardrobe.add(user.id, { title: "白色衬衫", category: "衬衫", colors: ["白色"] });
  const patched = await call("PATCH", `/api/wardrobe/items/${shirt.id}`, { colors: ["蓝色"], titleEn: "Blue shirt" }, token);
  assert.deepEqual([patched.body.item.colors, patched.body.item.titleEn, patched.body.item.kind], [["蓝色"], "Blue shirt", "top"]);

  const queued = await call("POST", "/api/trip-plans/generate", {
    scenario: "travel", placeName: "京都", placeDetail: "日本", lat: 35.01, lon: 135.77,
    startDate: "2026-09-01", endDate: "2026-09-01", notes: "",
  }, token);
  assert.equal(queued.status, 202);
  const planId = queued.body.plan.id;
  let plan = queued.body.plan;
  for (let i = 0; i < 50 && plan.generationStatus === "processing"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    plan = (await call("GET", `/api/trip-plans/${planId}`, undefined, token)).body.plan;
  }
  assert.equal(plan.generationStatus, "completed");

  const packing = (await call("GET", `/api/packing?balance=0&tripPlanId=${planId}`, undefined, token)).body.plan;
  const tops = packing.categories.find((c: { id: string }) => c.id === "tops");
  assert.equal(tops.items[0].wardrobeItemId, shirt.id, "worn-but-unpacked shirt was added");
  assert.equal(tops.items[0].wardrobeGap, false);

  const itemId = tops.items[0].id;
  const ticked = await call("PUT", "/api/packing/checks", { tripPlanId: planId, itemId, checked: true, balance: 0 }, token);
  assert.equal(ticked.body.plan.packedCount, 1);

  const trips = createPostgresTripPlanStore(pool);
  assert.deepEqual(await (await trips).weatherSnapshot(user.id, planId), snapshot);

  const itinerary = createPostgresItineraryStore(pool);
  const stopId = (await itinerary.get(user.id, plan.itineraryId))!.days[0].stops[0].id;
  await itinerary.markStopPhotoMissing(user.id, stopId, 1234);
  assert.equal((await itinerary.stop(user.id, stopId))?.photoMissingAt, 1234);

  assert.equal((await call("DELETE", `/api/trip-plans/${planId}`, undefined, token)).status, 200);
  const left = await pool.query(`SELECT COUNT(*)::int AS n FROM packing_checks WHERE trip_plan_id = $1`, [planId]);
  assert.equal(left.rows[0].n, 0, "checklist rows cascade with the trip");
});

test("only one instance can take over an expired job", { skip }, async () => {
  const { user } = await register("pg-lease@example.com");
  const trips = await createPostgresTripPlanStore(pool);
  const saved = await trips.save(user.id, {
    scenario: "travel", placeName: "京都", placeDetail: "", lat: 35, lon: 135,
    startDate: "2026-09-01", endDate: "2026-09-01",
  });
  await trips.startGeneration(user.id, saved.id, { token: "dead", leaseMs: 1_000 });
  const expired = await trips.expiredGenerations(2_000);
  assert.ok(expired.some((job) => job.planId === saved.id && job.attempts === 1));
  const claims = await Promise.all([
    trips.takeOverGeneration(saved.id, 2_000, { token: "a", leaseMs: 9_000 }),
    trips.takeOverGeneration(saved.id, 2_000, { token: "b", leaseMs: 9_000 }),
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
  await trips.markFailed(user.id, saved.id, "stale", "dead");
  assert.equal((await trips.get(user.id, saved.id))?.generationStatus, "processing");
});
