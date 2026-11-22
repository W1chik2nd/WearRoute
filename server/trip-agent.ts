import { structuredResponse } from "./ai.ts";
import { buildProfileFacts, type ProfileForPrompt } from "./prompts.ts";
import { destinationForecast } from "./weather.ts";
import type { WardrobeItem } from "./wardrobe.ts";
import type { NewTripPlan } from "./trip-plan.ts";
import { TRIP_AGENT_PROMPT, tripPlanSchema } from "./trip-agent-prompt.ts";
import type { GeneratedTripPlan } from "./trip-agent-types.ts";
import { isoDateRange } from "../shared/trip-constraints.ts";
import { wardrobeKind, type WardrobeKind } from "./wardrobe-kind.ts";

export { isoDateRange as tripDates } from "../shared/trip-constraints.ts";

export type TripAgentInput = {
  user: ProfileForPrompt & { id: string };
  plan: NewTripPlan;
  wardrobe: WardrobeItem[];
};

export type GenerateTrip = (input: TripAgentInput) => Promise<GeneratedTripPlan>;

/** `wardrobeItemId` may be blank to mark a genuine wardrobe gap. */
function blankRequiredTextPath(
  value: unknown,
  key = "",
  path = "$"
): string | null {
  if (typeof value === "string") {
    return key !== "wardrobeItemId" && value.trim().length === 0 ? path : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const blank = blankRequiredTextPath(value[index], "", `${path}[${index}]`);
      if (blank) return blank;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      const blank = blankRequiredTextPath(child, childKey, `${path}.${childKey}`);
      if (blank) return blank;
    }
  }
  return null;
}

function present(value: string, fallback: string): string {
  return value.trim() || fallback;
}

/**
 * Empty text is valid JSON Schema but not useful UI. Repair only fields with a
 * truthful deterministic fallback; critical itinerary content remains strict.
 */
function repairDerivableText(raw: GeneratedTripPlan): void {
  raw.departLabel = present(raw.departLabel, raw.days[0]?.date.slice(5) ?? "Trip");
  for (const day of raw.days) {
    day.dateLabel = present(day.dateLabel, day.date.slice(5));
    day.weatherRisk = present(
      day.weatherRisk,
      "未提供具体天气风险，请在出发前核对实时天气。"
    );
    day.weatherRiskEn = present(
      day.weatherRiskEn,
      "No specific weather risk was provided; check live conditions before departure."
    );
    for (const stop of day.stops) {
      stop.note = present(stop.note, "按计划前往，抵达前确认现场信息。");
      stop.noteEn = present(
        stop.noteEn,
        "Continue as planned and confirm local details before arrival."
      );
      stop.photoQuery = present(
        stop.photoQuery,
        `${stop.nameEn || stop.name} ${day.cityEn || day.city}`.trim()
      );
    }
  }
}

/**
 * Structured Outputs guarantees schema shape; these checks enforce business
 * invariants the schema cannot express (exact dates and real wardrobe IDs).
 */
export function normalizeGeneratedTrip(
  raw: GeneratedTripPlan,
  dates: string[],
  wardrobe: WardrobeItem[]
): GeneratedTripPlan {
  if (!raw || !Array.isArray(raw.days) || !raw.packing?.categories) {
    throw new Error("AI trip planner returned an incomplete plan.");
  }
  repairDerivableText(raw);
  const blankPath = blankRequiredTextPath(raw);
  if (blankPath) {
    throw new Error(
      `AI trip planner returned an empty required text field at ${blankPath}.`
    );
  }
  if (
    raw.days.length !== dates.length ||
    raw.days.some((day, i) => day.date !== dates[i])
  ) {
    throw new Error("AI trip planner returned the wrong travel dates.");
  }

  reconcileWardrobe(raw, dates.length, wardrobe);
  return raw;
}

// Packing rows the server adds for owned pieces the model wore but forgot to
// pack. Ids match the enum in trip-agent-prompt.ts.
const PACKING_CATEGORY: Record<WardrobeKind | "other", { id: string; title: string; titleEn: string }> = {
  top: { id: "tops", title: "上装", titleEn: "Tops" },
  pants: { id: "bottoms", title: "下装", titleEn: "Bottoms" },
  skirt: { id: "bottoms", title: "下装", titleEn: "Bottoms" },
  shoes: { id: "shoes", title: "鞋履", titleEn: "Shoes" },
  accessory: { id: "accessories", title: "配饰", titleEn: "Accessories" },
  other: { id: "accessories", title: "配饰", titleEn: "Accessories" },
};

/**
 * The daily outfits are the source of truth for owned clothing; the packing
 * list is derived from them rather than trusted alongside them.
 *
 * Previously an owned piece worn in an outfit but missing from the packing
 * list was rewritten as a wardrobe gap (telling the user to buy something
 * they own), and each row's daysUsed was whatever the model claimed, so the
 * checklist and the day cards could disagree.
 */
function reconcileWardrobe(
  raw: GeneratedTripPlan,
  dayCount: number,
  wardrobe: WardrobeItem[]
): void {
  const ownedItems = new Map(wardrobe.map((item) => [item.id, item]));
  const wornOn = new Map<string, Set<number>>();
  const englishLabel = new Map<string, string>();

  raw.days.forEach((day, index) => {
    day.outfit = day.outfit.map((item) => {
      const owned = item.wardrobeItemId ? ownedItems.get(item.wardrobeItemId) : undefined;
      if (!owned) return { ...item, wardrobeItemId: "", hasPhoto: false };
      wornOn.set(owned.id, (wornOn.get(owned.id) ?? new Set()).add(index + 1));
      const labelEn = item.labelEn || owned.titleEn || owned.title;
      englishLabel.set(owned.id, labelEn);
      return { ...item, label: owned.title, labelEn, hasPhoto: owned.hasPhoto };
    });
  });

  const packed = new Set<string>();
  for (const category of raw.packing.categories) {
    category.items = category.items.filter((item) => {
      if (item.wardrobeItemId && !ownedItems.has(item.wardrobeItemId)) {
        item.wardrobeItemId = "";
      }
      // One row per owned piece; a repeated row would double-count it.
      if (item.wardrobeItemId && packed.has(item.wardrobeItemId)) return false;
      const worn = item.wardrobeItemId ? wornOn.get(item.wardrobeItemId) : undefined;
      if (worn) {
        packed.add(item.wardrobeItemId);
        item.daysUsed = [...worn].sort((a, b) => a - b);
        // Worn in the itinerary, so even the leanest packing keeps it.
        item.priority = "core";
      } else {
        item.daysUsed = [...new Set(item.daysUsed)]
          .filter((day) => Number.isInteger(day) && day >= 1 && day <= dayCount)
          .sort((a, b) => a - b);
        if (item.daysUsed.length === 0) item.daysUsed = [1];
      }
      item.reuse = item.daysUsed.length;
      return true;
    });
  }

  for (const [id, days] of wornOn) {
    if (packed.has(id)) continue;
    const owned = ownedItems.get(id)!;
    const target = PACKING_CATEGORY[wardrobeKind(owned) ?? "other"];
    let category = raw.packing.categories.find((c) => c.id === target.id);
    if (!category) {
      category = { ...target, items: [] };
      raw.packing.categories.push(category);
    }
    const daysUsed = [...days].sort((a, b) => a - b);
    category.items.push({
      label: owned.title,
      labelEn: englishLabel.get(id) ?? (owned.titleEn || owned.title),
      quantity: 1,
      reuse: daysUsed.length,
      priority: "core",
      daysUsed,
      wardrobeItemId: id,
    });
  }
}

export const generateTrip: GenerateTrip = async ({ user, plan, wardrobe }) => {
  const dates = isoDateRange(plan.startDate, plan.endDate);
  const forecast = await destinationForecast(
    plan.lat,
    plan.lon,
    plan.startDate,
    plan.endDate
  );
  const generated = await structuredResponse<GeneratedTripPlan>({
    instructions: TRIP_AGENT_PROMPT,
    safetyIdentifier: user.id,
    schema: tripPlanSchema(dates.length),
    // A two-day plan should not reserve the same 64k budget as a 30-day plan.
    // Keeping the ceiling proportional materially shortens gateway time-to-first-byte.
    maxOutputTokens: Math.min(56_000, 10_000 + dates.length * 1_500),
    input: {
      profile: buildProfileFacts(user),
      wardrobe: wardrobe.map((item) => ({
        wardrobeItemId: item.id,
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
      })),
      trip: {
        scenario: plan.scenario,
        destination: plan.placeName,
        destinationDetail: plan.placeDetail,
        dates,
        userAgenda: plan.notes,
      },
      weather: forecast,
    },
  });
  return {
    ...normalizeGeneratedTrip(generated, dates, wardrobe),
    weatherSnapshot: forecast,
  };
};
