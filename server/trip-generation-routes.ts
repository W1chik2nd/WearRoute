import { type IncomingMessage, type ServerResponse } from "node:http";
import { aiConfigured } from "./ai.ts";
import type { TripPlanStore } from "./trip-plan.ts";
import type { TripJobs } from "./trip-jobs.ts";
import {
  estimateTripGeneration,
  parseTripInput,
  tripDayCount,
} from "./trip-input.ts";
import type { AsyncValue } from "./async-value.ts";

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  scenarioIds: ReadonlySet<string>;
  tripPlans: TripPlanStore;
  jobs: TripJobs;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage, maxBytes?: number) => Promise<any>;
  userFromHeader: () => AsyncValue<{ id: string } | null>;
};

/** Queue and persist one complete, linked WearRoute travel decision. */
export async function handleTripGenerationRoutes(ctx: Ctx): Promise<boolean> {
  const { req, res, url, json } = ctx;
  if (req.method !== "POST" || url.pathname !== "/api/trip-plans/generate") {
    return false;
  }

  const user = await ctx.userFromHeader();
  if (!user) {
    json(res, 401, { error: "Not signed in." });
    return true;
  }
  const body = await ctx.readBody(req);
  const parsed = parseTripInput(body, ctx.scenarioIds);
  if (parsed.ok === false) {
    json(res, 400, { error: parsed.error });
    return true;
  }
  const replaceFailedPlanId = body?.replaceFailedPlanId;
  if (
    replaceFailedPlanId !== undefined &&
    (typeof replaceFailedPlanId !== "string" || !replaceFailedPlanId.trim())
  ) {
    json(res, 400, { error: "replaceFailedPlanId must be a trip id." });
    return true;
  }
  if (typeof replaceFailedPlanId === "string") {
    const failedPlan = await ctx.tripPlans.get(user.id, replaceFailedPlanId);
    if (!failedPlan) {
      json(res, 404, { error: "Failed trip not found." });
      return true;
    }
    if (failedPlan.generationStatus !== "failed") {
      json(res, 409, { error: "Only a failed trip can be replaced." });
      return true;
    }
  }
  if (!aiConfigured()) {
    json(res, 503, {
      error:
        "旅行 Agent 尚未配置。请在 server/.env 填写 AI_API_KEY 后重试。",
    });
    return true;
  }

  const plan = await ctx.tripPlans.save(user.id, parsed.plan);
  // The job state lives on the trip row (trip-jobs.ts), so the status stays
  // visible across page changes and survives a server restart.
  await ctx.jobs.start(user.id, plan.id);
  plan.generationStatus = "processing";
  if (typeof replaceFailedPlanId === "string") {
    await ctx.tripPlans.remove(user.id, replaceFailedPlanId);
  }

  json(res, 202, {
    plan,
    replacedPlanId:
      typeof replaceFailedPlanId === "string" ? replaceFailedPlanId : null,
    estimate: estimateTripGeneration(
      tripDayCount(plan.startDate, plan.endDate)
    ),
  });
  return true;
}
