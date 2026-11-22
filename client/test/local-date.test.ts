import assert from "node:assert/strict";
import test from "node:test";
import { localIsoDate } from "../src/lib/local-date.ts";

test("uses the local calendar day, not the UTC one", () => {
  // 00:30 local time on 1 September, in whatever zone the test runs in.
  const earlyMorning = new Date(2026, 8, 1, 0, 30);
  assert.equal(localIsoDate(earlyMorning), "2026-09-01");
  const lateEvening = new Date(2026, 8, 1, 23, 30);
  assert.equal(localIsoDate(lateEvening), "2026-09-01");
});
