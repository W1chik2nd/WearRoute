// Durable trip-generation jobs.
//
// Generation takes minutes, so it runs after the HTTP request has answered
// 202. The job's state lives on the trip_plans row rather than only in this
// process: the worker holds a lease it renews every minute, and a job whose
// lease lapses (the instance restarted, crashed, or was replaced by a deploy)
// is taken over and re-run by whichever instance sweeps first. Completion is
// one transaction guarded by the worker's token, so a late result from a
// worker that lost its lease, or for a trip the user deleted, is discarded.
import { randomUUID } from "node:crypto";
import type { GenerateTrip, TripAgentInput } from "./trip-agent.ts";
import type { TripPlanStore } from "./trip-plan.ts";
import type { WardrobeStore } from "./wardrobe.ts";
import { tripDayCount } from "./trip-input.ts";
import type { AsyncValue } from "./async-value.ts";

export const LEASE_MS = 3 * 60_000;
const HEARTBEAT_MS = 60_000;
const SWEEP_MS = 60_000;
/** The first run plus one automatic resume after an interruption. */
const MAX_ATTEMPTS = 2;
const INTERRUPTED = "Generation was interrupted. Please try again.";

type Deps = {
  tripPlans: TripPlanStore;
  wardrobe: WardrobeStore;
  userById: (id: string) => AsyncValue<TripAgentInput["user"] | null>;
  generateTrip: GenerateTrip;
  now?: () => number;
  /** Tests sweep by hand; the server sweeps on start and every minute. */
  autoSweep?: boolean;
};

export type TripJobs = {
  /** Mark the trip processing and run the agent in the background. */
  start: (userId: string, planId: string) => Promise<void>;
  /** Resume or fail jobs whose lease lapsed. Returns the plan ids resumed. */
  sweep: () => Promise<string[]>;
  stop: () => void;
};

function failureMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? "旅行 Agent 生成失败,请稍后重试。")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function createTripJobs(deps: Deps): TripJobs {
  const now = deps.now ?? Date.now;
  const lease = (token: string) => ({ token, leaseMs: now() + LEASE_MS });
  let sweeper: NodeJS.Timeout | undefined;

  async function run(userId: string, planId: string, token: string): Promise<void> {
    const heartbeat = setInterval(() => {
      Promise.resolve(deps.tripPlans.renewGeneration(planId, lease(token))).catch((error) =>
        console.error(`[trip-jobs] heartbeat for ${planId} failed: ${failureMessage(error)}`)
      );
    }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const [plan, user] = await Promise.all([
        deps.tripPlans.get(userId, planId),
        deps.userById(userId),
      ]);
      if (!plan || !user) return; // Deleted meanwhile: nothing to report to.
      const generated = await deps.generateTrip({
        user,
        plan,
        wardrobe: await deps.wardrobe.list(userId),
      });
      await deps.tripPlans.completeGeneration({
        userId,
        planId,
        token,
        scenario: plan.scenario,
        tripDays: tripDayCount(plan.startDate, plan.endDate),
        generated,
      });
    } catch (error) {
      // A failure while recording the failure must not become an unhandled
      // rejection: that would terminate the whole server.
      await Promise.resolve(
        deps.tripPlans.markFailed(userId, planId, failureMessage(error), token)
      ).catch((markError) =>
        console.error(`[trip-jobs] could not mark ${planId} failed: ${failureMessage(markError)}`)
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function sweep(): Promise<string[]> {
    const resumed: string[] = [];
    for (const job of await deps.tripPlans.expiredGenerations(now())) {
      if (job.attempts >= MAX_ATTEMPTS) {
        await deps.tripPlans.markFailed(job.userId, job.planId, INTERRUPTED);
        continue;
      }
      const token = randomUUID();
      if (await deps.tripPlans.takeOverGeneration(job.planId, now(), lease(token))) {
        resumed.push(job.planId);
        void run(job.userId, job.planId, token);
      }
    }
    return resumed;
  }

  const safeSweep = () =>
    sweep().catch((error) => console.error(`[trip-jobs] sweep failed: ${failureMessage(error)}`));

  if (deps.autoSweep !== false) {
    // Pick up anything a previous process left behind, then keep checking.
    void safeSweep();
    sweeper = setInterval(safeSweep, SWEEP_MS);
    sweeper.unref();
  }

  return {
    async start(userId, planId) {
      const token = randomUUID();
      await deps.tripPlans.startGeneration(userId, planId, lease(token));
      setImmediate(() => void run(userId, planId, token));
    },
    sweep,
    stop() {
      if (sweeper) clearInterval(sweeper);
    },
  };
}
