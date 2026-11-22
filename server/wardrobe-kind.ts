// The one place that decides what kind of garment a wardrobe item is.
//
// Before this module the server, the web filter and the iOS filter each kept
// their own keyword list, and they disagreed: T恤/针织衫/卫衣 (three of the
// categories the vision prompt itself emits) became "accessories" on the
// server, and "连帽卫衣" matched 帽 and was filed under hats. Clients now read
// `kind` from the API instead of re-deriving it (AGENTS.md §3).
import type { WardrobeKind } from "../shared/wardrobe-types.ts";
import type { OutfitPieceKind } from "../shared/outfit-types.ts";

export type { WardrobeKind } from "../shared/wardrobe-types.ts";

type Classifiable = { category: string; subtype?: string; title?: string };

// Exact category labels: everything the vision prompt and normalizeCategory()
// produce, the assistant's English words, and the demo data's generic labels.
const EXACT: Record<string, WardrobeKind> = {
  t恤: "top", 衬衫: "top", 针织衫: "top", 卫衣: "top", 外套: "top",
  上衣: "top", 上装: "top", 衣服: "top", top: "top", tops: "top",
  裤装: "pants", 裤子: "pants", 长裤: "pants", 短裤: "pants",
  pants: "pants", trousers: "pants",
  裙装: "skirt", 裙子: "skirt", 半裙: "skirt", 连衣裙: "skirt",
  skirt: "skirt", dress: "skirt",
  鞋履: "shoes", 鞋子: "shoes", shoe: "shoes", shoes: "shoes", footwear: "shoes",
  配饰: "accessory", 配件: "accessory", accessory: "accessory", accessories: "accessory",
};

const GENERIC_BOTTOM = new Set(["下装", "bottom", "bottoms"]);

// Ordered fallback for free-form categories. Order matters: skirts before
// trousers (裙裤, 包臀裙), anything wearable before accessories so the 帽 in
// 连帽卫衣 and the 包 in 包臀裙 never win.
const KEYWORDS: [WardrobeKind, RegExp][] = [
  ["skirt", /裙|\b(skirt|dress)e?s?\b/],
  ["pants", /裤|\b(pants|trousers?|jeans|shorts|leggings)\b/],
  ["shoes", /鞋|靴|\b(shoes?|sneakers?|loafers?|boots?|sandals?|trainers?)\b/],
  [
    "top",
    /t恤|衫|卫衣|外套|夹克|大衣|风衣|羽绒|西装|马甲|背心|毛衣|针织|上衣|上装|\b(polo|tops?|shirts?|tees?|blouses?|sweaters?|hoodies?|jackets?|coats?|blazers?|cardigans?|vests?|sweatshirts?)\b/,
  ],
  [
    "accessory",
    /包|帽|围巾|眼镜|墨镜|手表|腕表|项链|首饰|珠宝|腰带|皮带|领带|手套|耳环|戒指|手链|\b(bags?|hats?|caps?|scarf|scarves|glasses|sunglasses|watch(es)?|belts?|ties?|gloves?|jewel(le)?ry|necklaces?)\b/,
  ],
];

function byKeywords(text: string): WardrobeKind | null {
  return KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** Canonical kind for one item; null when nothing recognisable is present. */
export function wardrobeKind(item: Classifiable): WardrobeKind | null {
  const category = item.category.trim().toLowerCase();
  const detail = `${item.subtype ?? ""} ${item.title ?? ""}`.toLowerCase();
  if (EXACT[category]) return EXACT[category];
  if (GENERIC_BOTTOM.has(category)) {
    return byKeywords(detail) === "skirt" ? "skirt" : "pants";
  }
  // The category field is the model's own judgement, so it outranks words
  // that happen to appear in the title.
  return byKeywords(category) ?? byKeywords(detail);
}

/** Outfit slots collapse skirts and trousers into one "bottom" slot. */
export function outfitKindOf(kind: WardrobeKind | null): OutfitPieceKind | null {
  if (kind === "pants" || kind === "skirt") return "bottom";
  return kind;
}
