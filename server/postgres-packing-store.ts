import type { GeneratedPacking } from "./trip-agent-types.ts";
import type { StoredGeneratedPacking } from "./packing.ts";
import {
  storedPacking,
  type GeneratedPackingRecord,
  type PackingPlanStore,
} from "./packing-store.ts";
import { row, rows, type PostgresPool, type PostgresQueryable } from "./postgres.ts";

/** Insert or replace one generated plan; used inside the completion transaction. */
export async function insertGeneratedPacking(
  db: PostgresQueryable,
  userId: string,
  tripPlanId: string,
  tripDays: number,
  packing: GeneratedPacking
): Promise<GeneratedPackingRecord> {
  const plan = storedPacking(packing);
  await db.query(
    `INSERT INTO generated_packing_plans
       (trip_plan_id, user_id, trip_days, plan_json)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (trip_plan_id) DO UPDATE
       SET trip_days = EXCLUDED.trip_days,
           plan_json = EXCLUDED.plan_json,
           created_at = NOW()`,
    [tripPlanId, userId, tripDays, JSON.stringify(plan)]
  );
  return { tripPlanId, tripDays, packing: plan };
}

function toRecord(value: {
  trip_plan_id: string;
  trip_days: number;
  plan_json: string;
}): GeneratedPackingRecord {
  return {
    tripPlanId: value.trip_plan_id,
    tripDays: value.trip_days,
    packing: JSON.parse(value.plan_json) as StoredGeneratedPacking,
  };
}

export function createPostgresPackingPlanStore(
  pool: PostgresPool
): PackingPlanStore {
  return {
    save(userId, tripPlanId, tripDays, packing) {
      return insertGeneratedPacking(pool, userId, tripPlanId, tripDays, packing);
    },

    async get(userId, tripPlanId) {
      const value = await row<{
        trip_plan_id: string;
        trip_days: number;
        plan_json: string;
      }>(
        pool,
        `SELECT trip_plan_id, trip_days, plan_json
           FROM generated_packing_plans
          WHERE user_id = $1 AND trip_plan_id = $2`,
        [userId, tripPlanId]
      );
      return value ? toRecord(value) : null;
    },

    async latest(userId, scenario) {
      const values: unknown[] = [userId];
      const scenarioClause = scenario ? `AND t.scenario = $2` : "";
      if (scenario) values.push(scenario);
      const value = await row<{
        trip_plan_id: string;
        trip_days: number;
        plan_json: string;
      }>(
        pool,
        `SELECT p.trip_plan_id, p.trip_days, p.plan_json
           FROM generated_packing_plans p
           JOIN trip_plans t ON t.id = p.trip_plan_id
          WHERE p.user_id = $1 ${scenarioClause}
          ORDER BY p.created_at DESC, p.trip_plan_id DESC
          LIMIT 1`,
        values
      );
      return value ? toRecord(value) : null;
    },

    async checks(userId, tripPlanId) {
      return (
        await rows<{ item_id: string }>(
          pool,
          `SELECT item_id FROM packing_checks WHERE user_id = $1 AND trip_plan_id = $2`,
          [userId, tripPlanId]
        )
      ).map((value) => value.item_id);
    },

    async setChecks(userId, tripPlanId, itemIds, checked) {
      if (itemIds.length === 0) return;
      await pool.query(
        checked
          ? `INSERT INTO packing_checks (trip_plan_id, user_id, item_id)
             SELECT $1, $2, UNNEST($3::text[])
             ON CONFLICT DO NOTHING`
          : `DELETE FROM packing_checks
              WHERE trip_plan_id = $1 AND user_id = $2 AND item_id = ANY($3::text[])`,
        [tripPlanId, userId, itemIds]
      );
    },
  };
}
