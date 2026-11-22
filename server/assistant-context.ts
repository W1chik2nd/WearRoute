// Database context added to the assistant prompt. Recommendations and actions
// should use real user data rather than guessing wardrobe ids or existing trips.
import type { WardrobeItem } from "./wardrobe.ts";
import type { TripPlan } from "./trip-plan.ts";
import type { GeneratedPackingRecord } from "./packing-store.ts";

function compactWardrobe(items: WardrobeItem[]): unknown[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    titleEn: item.titleEn,
    category: item.category,
    subtype: item.subtype,
    count: item.count,
    colors: item.colors,
    fit: item.fit,
    material: item.material,
    seasons: item.seasons,
    styleTags: item.styleTags,
    details: item.details,
  }));
}

function compactTrips(plans: TripPlan[]): unknown[] {
  return plans.map((plan) => ({
    id: plan.id,
    scenario: plan.scenario,
    placeName: plan.placeName,
    placeDetail: plan.placeDetail,
    startDate: plan.startDate,
    endDate: plan.endDate,
  }));
}

// The packingChecklist action needs real item ids; without them the model
// could only invent ids and the action silently did nothing.
function compactPacking(record: GeneratedPackingRecord | null): unknown {
  if (!record) return null;
  return {
    tripPlanId: record.tripPlanId,
    items: [
      ...record.packing.categories.flatMap((category) => category.items),
      ...record.packing.essentials,
    ].map((item) => ({ id: item.id, label: item.label, labelEn: item.labelEn })),
  };
}

export function assistantDataContext(
  wardrobeItems: WardrobeItem[],
  tripPlans: TripPlan[],
  packing: GeneratedPackingRecord | null = null
): string {
  const wardrobe = compactWardrobe(wardrobeItems);
  const trips = compactTrips(tripPlans);
  return `\n\n## Current database data\nWardrobe items: ${JSON.stringify(wardrobe)}\nSaved trip plans: ${JSON.stringify(trips)}\nLatest packing checklist: ${JSON.stringify(compactPacking(packing))}\nUse these exact ids for updates/deletes and checklist changes. An empty array or null means there is no saved data.`;
}
