import assert from "node:assert/strict";
import test from "node:test";
import { filterWardrobeItems } from "../src/lib/wardrobe-filter.ts";
import { DEMO_WARDROBE_ITEMS } from "../../server/demo-wardrobe.ts";
import { wardrobeKind } from "../../server/wardrobe-kind.ts";

// Items as the API returns them: the server attaches `kind`.
const withKind = <T extends { category: string; subtype?: string; title?: string }>(
  item: T
) => ({ ...item, kind: wardrobeKind(item) });

const items = [
  { id: "tee", title: "白色纯棉T恤", category: "T恤", subtype: "圆领T恤" },
  { id: "hoodie", title: "黑色宽松连帽卫衣", category: "卫衣", subtype: "连帽卫衣" },
  { id: "pants", title: "黑色直筒西裤", category: "下装", subtype: "长裤" },
  { id: "skirt", title: "米白色A字半裙", category: "下装", subtype: "半裙" },
  { id: "shoes", title: "白色复古运动鞋", category: "鞋履", subtype: "运动鞋" },
  { id: "scarf", title: "灰色轻薄围巾", category: "配饰", subtype: "围巾" },
].map(withKind);

test("全部品类保留原有顺序", () => {
  assert.deepEqual(filterWardrobeItems(items, "all"), items);
});

test("连帽卫衣归上装，不会因为“帽”字被当成配饰", () => {
  assert.deepEqual(
    filterWardrobeItems(items, "tops").map((item) => item.id),
    ["tee", "hoodie"]
  );
  assert.deepEqual(
    filterWardrobeItems(items, "accessories").map((item) => item.id),
    ["scarf"]
  );
});

test("裤装、裙装、鞋履各自独立筛选", () => {
  assert.deepEqual(filterWardrobeItems(items, "pants").map((item) => item.id), ["pants"]);
  assert.deepEqual(filterWardrobeItems(items, "skirts").map((item) => item.id), ["skirt"]);
  assert.deepEqual(filterWardrobeItems(items, "shoes").map((item) => item.id), ["shoes"]);
});

test("没有品类的单品只出现在“全部”里", () => {
  const unknown = { id: "umbrella", kind: null };
  for (const filter of ["tops", "pants", "skirts", "shoes", "accessories"] as const) {
    assert.equal(filterWardrobeItems([unknown], filter).length, 0);
  }
});

test("30 件演示衣橱在每个筛选项下都有正确数量", () => {
  const demo = DEMO_WARDROBE_ITEMS.map(withKind);
  assert.deepEqual(
    Object.fromEntries(
      (["tops", "pants", "skirts", "shoes", "accessories"] as const).map(
        (filter) => [filter, filterWardrobeItems(demo, filter).length]
      )
    ),
    { tops: 8, pants: 7, skirts: 1, shoes: 5, accessories: 9 }
  );
});
