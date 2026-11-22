// Checklist ticks are stored per trip on the server, against the real handler
// and a throwaway SQLite database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "./app.ts";
import type { GeneratedTripPlan } from "./trip-agent-types.ts";

let app: App;
let server: Server;
let base: string;
let dir: string;
let token: string;

function generated(): GeneratedTripPlan {
  const stop = { kind: "spot" as const, name: "外滩", nameEn: "The Bund", startTime: "09:00", duration: "1h", note: "步行", noteEn: "Walk", photoQuery: "Bund" };
  const row = (label: string, priority: "core" | "optional") => ({
    label, labelEn: label, quantity: 1, reuse: 1, priority, daysUsed: [1], wardrobeItemId: "",
  });
  return {
    title: "上海", titleEn: "Shanghai", departLabel: "9.1",
    days: [{
      date: "2026-09-01", dateLabel: "9.1", city: "上海", cityEn: "Shanghai",
      summary: "散步", summaryEn: "Walk", weatherSummary: "晴", weatherSummaryEn: "Sunny",
      weatherRisk: "无", weatherRiskEn: "None",
      outfit: [{ label: "衬衫", labelEn: "Shirt" }],
      equipment: [{ label: "伞", labelEn: "Umbrella" }],
      stops: [stop, stop, stop],
    }],
    packing: {
      summary: "", summaryEn: "",
      categories: [{ id: "tops", title: "上装", titleEn: "Tops", items: [row("衬衫", "core"), row("针织衫", "optional")] }],
      essentials: [{ label: "护照", labelEn: "Passport" }],
    },
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "wearroute-checks-"));
  process.env.AI_API_KEY = "test-key-not-used";
  app = createApp(join(dir, "test.db"), { generateTrip: async () => generated(), autoSweep: false });
  server = createServer(app.handle);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  const res = await call("POST", "/api/register", {
    email: "checks@example.com", password: "correct-horse", name: "Anna",
    gender: "female", age: 28, heightCm: 168, weightKg: 55,
  });
  token = res.body.token;
});

after(() => {
  delete process.env.AI_API_KEY;
  server.close();
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function generatedTrip(): Promise<string> {
  const queued = await call("POST", "/api/trip-plans/generate", {
    scenario: "travel", placeName: "上海", placeDetail: "中国", lat: 31.23, lon: 121.47,
    startDate: "2026-09-01", endDate: "2026-09-01", notes: "",
  });
  assert.equal(queued.status, 202);
  for (let i = 0; i < 50; i++) {
    const plan = (await call("GET", `/api/trip-plans/${queued.body.plan.id}`)).body.plan;
    if (plan.generationStatus === "completed") return plan.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("generation did not complete");
}

test("ticks persist per trip and progress counts only what is shown", async () => {
  const [first, second] = [await generatedTrip(), await generatedTrip()];
  const shown = (await call("GET", `/api/packing?balance=0&tripPlanId=${first}`)).body.plan;
  assert.deepEqual([shown.packedCount, shown.totalCount], [0, 2], "lean: core shirt + passport");

  const shirt = shown.categories[0].items[0].id;
  const tick = (tripPlanId: string, itemId: string, checked: boolean) =>
    call("PUT", "/api/packing/checks", { tripPlanId, itemId, checked, balance: 0 });
  const ticked = await tick(first, shirt, true);
  assert.deepEqual(ticked.body.plan.checked, [shirt]);
  assert.equal(ticked.body.plan.packedCount, 1);

  const reloaded = (await call("GET", `/api/packing?balance=100&tripPlanId=${first}`)).body.plan;
  assert.deepEqual([reloaded.checked, reloaded.totalCount], [[shirt], 3], "survives a reload");
  const other = (await call("GET", `/api/packing?balance=0&tripPlanId=${second}`)).body.plan;
  assert.equal(other.packedCount, 0, "ticks never leak into another trip");
  assert.equal((await tick(second, shirt, true)).status, 404, "item ids are checked per trip");

  assert.equal((await tick(first, shirt, false)).body.plan.packedCount, 0);
});
