import { randomUUID } from "node:crypto";
import type { NewTripPlan, TripPlan, TripPlanStore } from "./trip-plan.ts";
import { insertGenerated } from "./postgres-itinerary.ts";
import { insertGeneratedPacking } from "./postgres-packing-store.ts";
import {
  inTransaction,
  row,
  rows,
  type PostgresPool,
} from "./postgres.ts";

type TripPlanRow = {
  id: string;
  scenario: string;
  place_name: string;
  place_detail: string;
  lat: number;
  lon: number;
  start_date: string;
  end_date: string;
  notes: string;
  itinerary_id: string | null;
  generation_status: TripPlan["generationStatus"];
  generation_error: string | null;
  created_at: Date | string;
};

function toPlan(value: TripPlanRow): TripPlan {
  return {
    id: value.id,
    scenario: value.scenario,
    placeName: value.place_name,
    placeDetail: value.place_detail,
    lat: value.lat,
    lon: value.lon,
    startDate: value.start_date,
    endDate: value.end_date,
    notes: value.notes,
    itineraryId: value.itinerary_id,
    generationStatus: value.generation_status,
    generationError: value.generation_error,
    createdAt:
      value.created_at instanceof Date
        ? value.created_at.toISOString()
        : value.created_at,
  };
}

export async function createPostgresTripPlanStore(
  pool: PostgresPool
): Promise<TripPlanStore> {
  // Interrupted jobs are not failed on boot: during a rolling deploy another
  // instance may still be running them. Their lease lapses instead and the
  // job runner (trip-jobs.ts) takes them over.
  await pool.query(`
    UPDATE trip_plans
       SET generation_status = 'completed'
     WHERE itinerary_id IS NOT NULL AND generation_status = 'pending';
  `);

  return {
    async save(userId, plan: NewTripPlan) {
      const saved = await row<TripPlanRow>(
        pool,
        `INSERT INTO trip_plans
           (id, user_id, scenario, place_name, place_detail,
            lat, lon, start_date, end_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          randomUUID(),
          userId,
          plan.scenario,
          plan.placeName,
          plan.placeDetail,
          plan.lat,
          plan.lon,
          plan.startDate,
          plan.endDate,
          plan.notes ?? "",
        ]
      );
      return toPlan(saved!);
    },

    async get(userId, planId) {
      const value = await row<TripPlanRow>(
        pool,
        `SELECT * FROM trip_plans WHERE id = $1 AND user_id = $2`,
        [planId, userId]
      );
      return value ? toPlan(value) : null;
    },

    async list(userId) {
      return (
        await rows<TripPlanRow>(
          pool,
          `SELECT * FROM trip_plans
            WHERE user_id = $1
            ORDER BY created_at DESC, id DESC`,
          [userId]
        )
      ).map(toPlan);
    },

    async startGeneration(userId, planId, lease) {
      await pool.query(
        `UPDATE trip_plans
            SET generation_status = 'processing', generation_error = NULL,
                generation_token = $1, generation_lease_until = $2,
                generation_attempts = 1
          WHERE id = $3 AND user_id = $4`,
        [lease.token, lease.leaseMs, planId, userId]
      );
    },

    async renewGeneration(planId, lease) {
      const result = await pool.query(
        `UPDATE trip_plans SET generation_lease_until = $1
          WHERE id = $2 AND generation_status = 'processing'
            AND generation_token = $3`,
        [lease.leaseMs, planId, lease.token]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async expiredGenerations(now) {
      return (
        await rows<{ id: string; user_id: string; generation_attempts: number }>(
          pool,
          `SELECT id, user_id, generation_attempts FROM trip_plans
            WHERE generation_status = 'processing'
              AND (generation_lease_until IS NULL OR generation_lease_until < $1)`,
          [now]
        )
      ).map((value) => ({
        planId: value.id,
        userId: value.user_id,
        attempts: value.generation_attempts,
      }));
    },

    async takeOverGeneration(planId, now, lease) {
      const result = await pool.query(
        `UPDATE trip_plans
            SET generation_token = $1, generation_lease_until = $2,
                generation_attempts = generation_attempts + 1
          WHERE id = $3 AND generation_status = 'processing'
            AND (generation_lease_until IS NULL OR generation_lease_until < $4)`,
        [lease.token, lease.leaseMs, planId, now]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async markFailed(userId, planId, error, token) {
      await pool.query(
        `UPDATE trip_plans
            SET generation_status = 'failed', generation_error = $1,
                generation_token = NULL, generation_lease_until = NULL
          WHERE id = $2 AND user_id = $3
            AND ($4::text IS NULL OR generation_token = $4::text)`,
        [error, planId, userId, token ?? null]
      );
    },

    async completeGeneration({ userId, planId, token, scenario, tripDays, generated }) {
      return inTransaction(pool, async (client) => {
        const owned = await row(
          client,
          `SELECT 1 FROM trip_plans
            WHERE id = $1 AND user_id = $2 AND generation_status = 'processing'
              AND generation_token = $3
            FOR UPDATE`,
          [planId, userId, token]
        );
        if (!owned) return false;
        const itineraryId = await insertGenerated(client, userId, planId, scenario, generated);
        await insertGeneratedPacking(client, userId, planId, tripDays, generated.packing);
        await client.query(
          `UPDATE trip_plans
              SET itinerary_id = $1, generation_status = 'completed',
                  generation_error = NULL, generation_token = NULL,
                  generation_lease_until = NULL, weather_snapshot = $2
            WHERE id = $3`,
          [
            itineraryId,
            generated.weatherSnapshot ? JSON.stringify(generated.weatherSnapshot) : null,
            planId,
          ]
        );
        return true;
      });
    },

    async weatherSnapshot(userId, planId) {
      const value = await row<{ weather_snapshot: string | null }>(
        pool,
        `SELECT weather_snapshot FROM trip_plans WHERE id = $1 AND user_id = $2`,
        [planId, userId]
      );
      return value?.weather_snapshot ? JSON.parse(value.weather_snapshot) : null;
    },

    async remove(userId, planId) {
      return inTransaction(pool, async (client) => {
        await client.query(
          `DELETE FROM trips WHERE source_plan_id = $1 AND user_id = $2`,
          [planId, userId]
        );
        const result = await client.query(
          `DELETE FROM trip_plans WHERE id = $1 AND user_id = $2`,
          [planId, userId]
        );
        return (result.rowCount ?? 0) > 0;
      });
    },
  };
}
