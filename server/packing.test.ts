// Unit tests for the packing slider over the agent's stored list. No server
// or DB needed: buildGeneratedPackingPlan is pure (US 6.1–6.3, 7.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGeneratedPackingPlan,
  type StoredGeneratedPacking,
} from "./packing.ts";

// 装备类(充电宝、转换插头之类)压根不来自衣橱,空的 wardrobeItemId 只
// 说明它不是衣服。之前客户端拿 `wardrobeItemId === ""` 当缺口判据,导致
// 每一条装备都挂着「衣橱缺口」红标。判据现在由服务端给。
function gearFixture(): StoredGeneratedPacking {
  const item = (id: string, wardrobeItemId: string) => ({
    id,
    label: id,
    labelEn: id,
    reuse: 1,
    quantity: 1,
    daysUsed: [1],
    wardrobeItemId,
    priority: "core" as const,
  });
  return {
    summary: "s",
    summaryEn: "s",
    categories: [
      {
        id: "tops",
        title: "上衣",
        titleEn: "Tops",
        items: [item("owned-tee", "w-1"), item("missing-shirt", "")],
      },
      {
        id: "equipment",
        title: "装备",
        titleEn: "Equipment",
        items: [item("power-bank", ""), item("uk-adapter", "")],
      },
    ],
    essentials: [],
  };
}

test("gear never counts as a wardrobe gap, missing clothes still do", () => {
  const plan = buildGeneratedPackingPlan(gearFixture(), 50, 2);
  const byId = new Map(
    plan.categories.flatMap((c) => c.items).map((i) => [i.id, i])
  );

  assert.equal(byId.get("power-bank")?.wardrobeGap, false);
  assert.equal(byId.get("uk-adapter")?.wardrobeGap, false);
  assert.equal(byId.get("missing-shirt")?.wardrobeGap, true);
  assert.equal(byId.get("owned-tee")?.wardrobeGap, false);
});

function sliderFixture(): StoredGeneratedPacking {
  const item = (id: string, priority: "core" | "support" | "optional") => ({
    id, label: id, labelEn: id, reuse: 1, quantity: 1, daysUsed: [1],
    wardrobeItemId: `w-${id}`, priority,
  });
  return {
    summary: "以中性色为核心。",
    summaryEn: "Built around neutrals.",
    categories: [
      { id: "tops", title: "上装", titleEn: "Tops", items: [item("worn-shirt", "core"), item("spare-knit", "support"), item("extra-tee", "optional")] },
      { id: "equipment", title: "装备", titleEn: "Equipment", items: [{ ...item("adapter", "core"), wardrobeItemId: "" }] },
    ],
    essentials: [{ id: "passport", label: "护照", labelEn: "Passport" }],
  };
}

test("the leanest setting keeps core rows and the summary counts what is shown", () => {
  const lean = buildGeneratedPackingPlan(sliderFixture(), 0, 3);
  const varied = buildGeneratedPackingPlan(sliderFixture(), 100, 3);
  assert.deepEqual(lean.categories[0].items.map((i) => i.id), ["worn-shirt"]);
  assert.equal(varied.categories[0].items.length, 3);
  // Gear is not clothing, so it is not counted as a piece.
  assert.match(lean.summary, /^精简模式：1 件衣物覆盖 3 天/);
  assert.match(varied.summaryEn, /^Style mode: 3 pieces of clothing/);
  assert.match(lean.summaryEn, /Built around neutrals\.$/);
});

test("progress counts only ticked items that are currently shown", () => {
  const plan = buildGeneratedPackingPlan(
    sliderFixture(), 0, 3, ["worn-shirt", "extra-tee", "passport", "stale-id"]
  );
  assert.deepEqual(plan.checked, ["worn-shirt", "passport"]);
  assert.equal(plan.packedCount, 2);
  assert.equal(plan.totalCount, 3, "worn-shirt + adapter + passport");
});
