import assert from "node:assert/strict";
import test from "node:test";
import { outfitKindOf, wardrobeKind } from "./wardrobe-kind.ts";
import { wardrobeItemVisual } from "./outfit-plan.ts";
import { DEMO_WARDROBE_ITEMS } from "./demo-wardrobe.ts";

test("every category the vision prompt emits maps to a garment kind", () => {
  const expected = {
    T恤: "top", 衬衫: "top", 针织衫: "top", 卫衣: "top", 外套: "top",
    裤装: "pants", 裙装: "skirt", 鞋履: "shoes", 配饰: "accessory",
  } as const;
  for (const [category, kind] of Object.entries(expected)) {
    assert.equal(wardrobeKind({ category, subtype: "", title: "" }), kind, category);
  }
});

test("a hooded top is a top, not a hat", () => {
  assert.equal(
    wardrobeKind({ category: "卫衣", subtype: "连帽卫衣", title: "黑色宽松连帽卫衣" }),
    "top"
  );
  assert.equal(
    wardrobeKind({ category: "夹克", subtype: "连帽夹克", title: "藏蓝连帽夹克" }),
    "top"
  );
  assert.equal(wardrobeKind({ category: "帽子", subtype: "棒球帽", title: "藏蓝棒球帽" }), "accessory");
});

test("generic bottoms split into skirts and trousers by subtype", () => {
  assert.equal(wardrobeKind({ category: "下装", subtype: "半裙", title: "米白A字半裙" }), "skirt");
  assert.equal(wardrobeKind({ category: "下装", subtype: "长裤", title: "黑色西裤" }), "pants");
  assert.equal(wardrobeKind({ category: "包臀裙", subtype: "", title: "" }), "skirt");
});

test("unrecognisable items stay unclassified instead of being guessed", () => {
  assert.equal(wardrobeKind({ category: "雨伞", subtype: "", title: "折叠伞" }), null);
});

test("outfit visuals use the same classification", () => {
  const base = {
    id: "x", count: 1, colors: ["白色"], fit: "宽松", material: "棉", seasons: [],
    styleTags: [], details: "", hasPhoto: false, createdAt: "",
  };
  const tee = wardrobeItemVisual({ ...base, category: "T恤", subtype: "圆领T恤", title: "白色T恤" });
  const hoodie = wardrobeItemVisual({ ...base, category: "卫衣", subtype: "连帽卫衣", title: "黑色卫衣" });
  assert.equal(tee.kind, "top");
  assert.equal(hoodie.kind, "top");
  assert.equal(hoodie.garmentStyle, "hoodie");
  assert.equal(outfitKindOf("skirt"), "bottom");
});

test("the demo wardrobe classifies into the expected counts", () => {
  const counts: Record<string, number> = {};
  for (const item of DEMO_WARDROBE_ITEMS) {
    const kind = wardrobeKind(item) ?? "none";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  assert.deepEqual(counts, { top: 8, pants: 7, skirt: 1, shoes: 5, accessory: 9 });
});
