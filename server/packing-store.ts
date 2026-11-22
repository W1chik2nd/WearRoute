import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { GeneratedPacking } from "./trip-agent-types.ts";
import type { StoredGeneratedPacking } from "./packing.ts";
import type { AsyncValue } from "./async-value.ts";

export type GeneratedPackingRecord = {
  tripPlanId: string;
  tripDays: number;
  packing: StoredGeneratedPacking;
};

export type PackingPlanStore = {
  save: (
    userId: string,
    tripPlanId: string,
    tripDays: number,
    packing: GeneratedPacking
  ) => AsyncValue<GeneratedPackingRecord>;
  get: (userId: string, tripPlanId: string) => AsyncValue<GeneratedPackingRecord | null>;
  latest: (userId: string, scenario?: string) => AsyncValue<GeneratedPackingRecord | null>;
  /** Ticked checklist item ids for one trip (packing items and essentials). */
  checks: (userId: string, tripPlanId: string) => AsyncValue<string[]>;
  setChecks: (
    userId: string,
    tripPlanId: string,
    itemIds: string[],
    checked: boolean
  ) => AsyncValue<void>;
};

/** Give every row and essential a stable id the checklist can refer to. */
export function storedPacking(packing: GeneratedPacking): StoredGeneratedPacking {
  return {
    summary: packing.summary,
    summaryEn: packing.summaryEn,
    categories: packing.categories.map((category) => ({
      id: category.id,
      title: category.title,
      titleEn: category.titleEn,
      items: category.items.map((item) => ({ id: randomUUID(), ...item })),
    })),
    essentials: packing.essentials.map((item) => ({ id: randomUUID(), ...item })),
  };
}

/** Insert one generated packing plan; used inside the completion transaction. */
export function insertGeneratedPacking(
  db: DatabaseSync,
  userId: string,
  tripPlanId: string,
  tripDays: number,
  packing: GeneratedPacking
): GeneratedPackingRecord {
  const plan = storedPacking(packing);
  db.prepare(
    `INSERT INTO generated_packing_plans
       (trip_plan_id, user_id, trip_days, plan_json)
     VALUES (?, ?, ?, ?)`
  ).run(tripPlanId, userId, tripDays, JSON.stringify(plan));
  return { tripPlanId, tripDays, packing: plan };
}

export function createPackingPlanStore(db: DatabaseSync): PackingPlanStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generated_packing_plans (
      trip_plan_id TEXT PRIMARY KEY REFERENCES trip_plans(id),
      user_id      TEXT NOT NULL REFERENCES users(id),
      trip_days    INTEGER NOT NULL,
      plan_json    TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_generated_packing_user
      ON generated_packing_plans(user_id, created_at);
    -- One row per ticked item. Kept on the server (not in browser storage) so
    -- the checklist survives a closed tab and matches on web and iOS.
    CREATE TABLE IF NOT EXISTS packing_checks (
      trip_plan_id TEXT NOT NULL REFERENCES trip_plans(id),
      user_id      TEXT NOT NULL REFERENCES users(id),
      item_id      TEXT NOT NULL,
      PRIMARY KEY (trip_plan_id, item_id)
    );
  `);

  function toRecord(row: {
    trip_plan_id: string;
    trip_days: number;
    plan_json: string;
  }): GeneratedPackingRecord {
    return {
      tripPlanId: row.trip_plan_id,
      tripDays: row.trip_days,
      packing: JSON.parse(row.plan_json) as StoredGeneratedPacking,
    };
  }

  return {
    save(userId, tripPlanId, tripDays, packing) {
      return insertGeneratedPacking(db, userId, tripPlanId, tripDays, packing);
    },

    get(userId, tripPlanId) {
      const row = db
        .prepare(
          `SELECT trip_plan_id, trip_days, plan_json
             FROM generated_packing_plans
            WHERE user_id = ? AND trip_plan_id = ?`
        )
        .get(userId, tripPlanId) as
        | { trip_plan_id: string; trip_days: number; plan_json: string }
        | undefined;
      return row ? toRecord(row) : null;
    },

    latest(userId, scenario) {
      const scenarioClause = scenario ? "AND t.scenario = ?" : "";
      const params = scenario ? [userId, scenario] : [userId];
      const row = db
        .prepare(
          `SELECT p.trip_plan_id, p.trip_days, p.plan_json
             FROM generated_packing_plans p
             JOIN trip_plans t ON t.id = p.trip_plan_id
            WHERE p.user_id = ? ${scenarioClause}
            ORDER BY p.created_at DESC, p.rowid DESC
            LIMIT 1`
        )
        .get(...params) as
        | { trip_plan_id: string; trip_days: number; plan_json: string }
        | undefined;
      return row ? toRecord(row) : null;
    },

    checks(userId, tripPlanId) {
      return (
        db
          .prepare(
            `SELECT item_id FROM packing_checks WHERE user_id = ? AND trip_plan_id = ?`
          )
          .all(userId, tripPlanId) as { item_id: string }[]
      ).map((row) => row.item_id);
    },

    setChecks(userId, tripPlanId, itemIds, checked) {
      const statement = checked
        ? db.prepare(
            `INSERT OR IGNORE INTO packing_checks (trip_plan_id, user_id, item_id)
             VALUES (?, ?, ?)`
          )
        : db.prepare(
            `DELETE FROM packing_checks
              WHERE trip_plan_id = ? AND user_id = ? AND item_id = ?`
          );
      for (const itemId of itemIds) statement.run(tripPlanId, userId, itemId);
    },
  };
}
