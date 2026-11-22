// WearRoute packing-plan generator.
//
// Architecture note (AGENTS.md §3): the entire packing plan is computed here
// on the server. The client sends only the user's slider value and renders
// whatever comes back — no packing rules, reuse math, or category logic live
// in the front end, so the future SwiftUI client reuses this untouched.
//
// The agent supplies the list (trip-agent.ts); this module only applies the
// slider. There is deliberately no generic fallback list: showing clothes the
// user does not own as "their" packing list would be a fake success
// (AGENTS.md §4). This serves (docs/personas-and-user-stories.md):
//   US 6.1 — the fewest items that still cover the whole trip
//   US 6.2 — show where each item is reused so the plan is trustworthy
//   US 6.3 — a slider trading outfit variety against luggage minimization
//   US 7.1 — a tickable checklist so nothing gets left behind
//   US 1.3 — surface how often each core piece is used
import type {
  CorePiece,
  EssentialItem,
  PackingCategory,
  PackingItem,
  PackingPlan,
} from "../shared/packing-types.ts";

export type {
  CorePiece,
  EssentialItem,
  PackingCategory,
  PackingItem,
  PackingPlan,
} from "../shared/packing-types.ts";

export type StoredGeneratedPacking = {
  summary: string;
  summaryEn: string;
  categories: (Omit<PackingCategory, "items"> & {
    items: Required<
      Pick<
        PackingItem,
        | "id"
        | "label"
        | "labelEn"
        | "reuse"
        | "quantity"
        | "daysUsed"
        | "wardrobeItemId"
        | "priority"
      >
    >[];
  })[];
  essentials: EssentialItem[];
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * 不来自衣橱的分类。充电宝、转换插头这类东西衣柜里根本不会有,空的
 * wardrobeItemId 只说明它不是衣服,不是「缺口」。分类 id 的全部取值见
 * trip-agent-prompt.ts 里 packing.categories 的 enum。
 */
const GEAR_CATEGORIES = new Set(["equipment"]);

/** The one-line count shown above the list always matches what is listed. */
function countSummary(b: number, pieces: number, tripDays: number) {
  if (b <= 33) {
    return {
      zh: `精简模式：${pieces} 件衣物覆盖 ${tripDays} 天，高复用、行李最轻。`,
      en: `Lean mode: ${pieces} pieces of clothing for ${tripDays} days — high reuse, lightest bag.`,
    };
  }
  if (b >= 67) {
    return {
      zh: `造型模式：${pieces} 件衣物，${tripDays} 天里搭配变化最多。`,
      en: `Style mode: ${pieces} pieces of clothing with the most variety across ${tripDays} days.`,
    };
  }
  return {
    zh: `均衡模式：${pieces} 件衣物覆盖 ${tripDays} 天，兼顾变化与行李空间。`,
    en: `Balanced mode: ${pieces} pieces of clothing for ${tripDays} days, balancing variety and space.`,
  };
}

/**
 * Apply the variety/light slider to the agent's prioritized list. Rows worn in
 * a daily outfit are stored as "core" (see normalizeGeneratedTrip), so the
 * leanest setting can never drop a piece the itinerary still dresses you in;
 * only support/optional extras appear as the user asks for more variety.
 */
export function buildGeneratedPackingPlan(
  source: StoredGeneratedPacking,
  balance: number,
  tripDays: number,
  checkedIds: Iterable<string> = []
): PackingPlan {
  const b = clamp(Math.round(balance), 0, 100);
  const include = (priority: "core" | "support" | "optional") =>
    priority === "core" ||
    (priority === "support" && b >= 34) ||
    (priority === "optional" && b >= 67);
  const categories = source.categories
    .map((category) => {
      const gear = GEAR_CATEGORIES.has(category.id);
      return {
        ...category,
        items: category.items
          .filter((item) => include(item.priority))
          .map((item) => ({
            ...item,
            wardrobeGap: !gear && !item.wardrobeItemId,
          })),
      };
    })
    .filter((category) => category.items.length > 0);
  const corePieces = categories
    .flatMap((category) => category.items)
    .sort((a, b) => b.reuse - a.reuse)
    .slice(0, 4)
    .map(({ id, label, labelEn, reuse }) => ({ id, label, labelEn, reuse }));
  const pieces = categories
    .filter((category) => !GEAR_CATEGORIES.has(category.id))
    .reduce((n, category) => n + category.items.length, 0);
  const counted = countSummary(b, pieces, tripDays);
  // Progress counts only what is on screen: a ticked item hidden by the
  // slider, or one left over from an earlier plan, is not "packed".
  const ticked = new Set(checkedIds);
  const visibleIds = [
    ...categories.flatMap((category) => category.items.map((item) => item.id)),
    ...source.essentials.map((item) => item.id),
  ];
  const checked = visibleIds.filter((id) => ticked.has(id));
  const join = (lead: string, advice: string) =>
    advice.trim() ? `${lead} ${advice.trim()}` : lead;

  return {
    balance: b,
    tripDays,
    summary: join(counted.zh, source.summary),
    summaryEn: join(counted.en, source.summaryEn),
    categories,
    essentials: source.essentials,
    corePieces,
    checked,
    packedCount: checked.length,
    totalCount: visibleIds.length,
  };
}

/** Every id a checklist tick may refer to, including slider-hidden rows. */
export function packingItemIds(source: StoredGeneratedPacking): Set<string> {
  return new Set([
    ...source.categories.flatMap((category) => category.items.map((item) => item.id)),
    ...source.essentials.map((item) => item.id),
  ]);
}
