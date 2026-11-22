// Packing plan and checklist routes, split out of app.ts (AGENTS.md §7).
import { type IncomingMessage, type ServerResponse } from "node:http";
import type { GeneratedPackingRecord, PackingPlanStore } from "./packing-store.ts";
import { buildGeneratedPackingPlan, packingItemIds } from "./packing.ts";
import type { AsyncValue } from "./async-value.ts";

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  packingPlans: PackingPlanStore;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage, maxBytes?: number) => Promise<any>;
  userFromHeader: () => AsyncValue<{ id: string } | null>;
};

/** Trust boundary (AGENTS.md §4): coerce the slider once; 50 when absent. */
function balanceOf(value: unknown): number {
  const raw = typeof value === "number" ? value : value == null ? NaN : Number(value);
  return Number.isFinite(raw) ? raw : 50;
}

async function render(
  packingPlans: PackingPlanStore,
  userId: string,
  record: GeneratedPackingRecord,
  balance: number
) {
  const checked = await packingPlans.checks(userId, record.tripPlanId);
  return buildGeneratedPackingPlan(record.packing, balance, record.tripDays, checked);
}

export async function handlePackingRoutes(ctx: Ctx): Promise<boolean> {
  const { req, res, url, packingPlans, json } = ctx;

  // `balance` is the one query knob: 0 = pack lightest, 100 = most outfit
  // variety (US 6.3). Without a generated trip there is no plan: the client
  // shows its empty state instead of a list of clothes the user does not own.
  if (req.method === "GET" && url.pathname === "/api/packing") {
    const user = await ctx.userFromHeader();
    if (!user) {
      json(res, 401, { error: "Not signed in." });
      return true;
    }
    const tripPlanId = url.searchParams.get("tripPlanId");
    const record = await (tripPlanId
      ? packingPlans.get(user.id, tripPlanId)
      : packingPlans.latest(user.id, url.searchParams.get("scenario") ?? undefined));
    if (!record) {
      json(res, 404, { error: "No packing plan yet. Generate a trip first." });
      return true;
    }
    json(res, 200, {
      plan: await render(
        packingPlans,
        user.id,
        record,
        balanceOf(url.searchParams.get("balance"))
      ),
    });
    return true;
  }

  // Tick or untick checklist items. Answers with the re-rendered plan so the
  // client never computes progress itself.
  if (req.method === "PUT" && url.pathname === "/api/packing/checks") {
    const user = await ctx.userFromHeader();
    if (!user) {
      json(res, 401, { error: "Not signed in." });
      return true;
    }
    const body = await ctx.readBody(req);
    const { tripPlanId, itemId, checked } = body ?? {};
    if (typeof tripPlanId !== "string" || typeof itemId !== "string" || typeof checked !== "boolean") {
      json(res, 400, { error: "tripPlanId, itemId and checked are required." });
      return true;
    }
    const record = await packingPlans.get(user.id, tripPlanId);
    if (!record) {
      json(res, 404, { error: "Packing plan not found for this trip." });
      return true;
    }
    if (!packingItemIds(record.packing).has(itemId)) {
      json(res, 404, { error: "Packing item not found." });
      return true;
    }
    await packingPlans.setChecks(user.id, tripPlanId, [itemId], checked);
    json(res, 200, {
      plan: await render(packingPlans, user.id, record, balanceOf(body.balance)),
    });
    return true;
  }

  return false;
}
