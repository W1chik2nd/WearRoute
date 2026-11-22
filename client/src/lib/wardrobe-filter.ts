import type { WardrobeKind } from "../../../shared/wardrobe-types";

export const WARDROBE_FILTER_OPTIONS = [
  { id: "all", labelKey: "wardrobeFilterAll" },
  { id: "tops", labelKey: "wardrobeFilterTops" },
  { id: "pants", labelKey: "wardrobeFilterPants" },
  { id: "skirts", labelKey: "wardrobeFilterSkirts" },
  { id: "shoes", labelKey: "wardrobeFilterShoes" },
  { id: "accessories", labelKey: "wardrobeFilterAccessories" },
] as const;

export type WardrobeFilterId = (typeof WARDROBE_FILTER_OPTIONS)[number]["id"];

// The server decides each item's kind (server/wardrobe-kind.ts); the filter
// only maps a chip to that kind, so web and iOS can never disagree.
const KIND_FOR_FILTER: Record<Exclude<WardrobeFilterId, "all">, WardrobeKind> = {
  tops: "top",
  pants: "pants",
  skirts: "skirt",
  shoes: "shoes",
  accessories: "accessory",
};

export function filterWardrobeItems<T extends { kind: WardrobeKind | null }>(
  items: T[],
  filter: WardrobeFilterId
): T[] {
  if (filter === "all") return items;
  return items.filter((item) => item.kind === KIND_FOR_FILTER[filter]);
}
