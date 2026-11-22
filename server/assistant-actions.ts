// Structured actions for the WearRoute assistant. Model output is untrusted:
// only this allow-list can reach database-backed operations.
import { parseTripInput } from "./trip-input.ts";
import type { NewTripPlan, TripPlanStore } from "./trip-plan.ts";
import type { WardrobeStore, NewItem, ItemPatch } from "./wardrobe.ts";
import { validateProfile, type ProfileValues } from "./profile.ts";
import type { AsyncValue } from "./async-value.ts";
import type { PackingPlanStore } from "./packing-store.ts";
import { packingItemIds } from "./packing.ts";

export const ASSISTANT_PAGES = [
  "home", "trips", "tripSetup", "itinerary", "wardrobe", "profile", "packing",
] as const;
export type AssistantPage = (typeof ASSISTANT_PAGES)[number];

export type AssistantAction =
  | { type: "navigate"; page: AssistantPage; scenario?: string }
  | { type: "updateProfile"; profile: Record<string, unknown> }
  | { type: "addWardrobeItem"; item: NewItem }
  | { type: "updateWardrobeItem"; id: string; patch: ItemPatch }
  | { type: "deleteWardrobeItem"; id: string }
  | { type: "packingChecklist"; checked?: string[]; unchecked?: string[]; balance?: number }
  | {
      type: "createTripPlan";
      /** Coordinates come from geocoding the name, never from the model. */
      plan: {
        scenario: string;
        placeName: string;
        startDate: string;
        endDate: string;
        notes?: string;
      };
    };

export type ClientAssistantAction =
  | { type: "navigate"; page: AssistantPage; scenario?: string }
  | { type: "profileUpdated"; user: unknown }
  | { type: "wardrobeChanged" }
  | { type: "tripCreated" }
  | { type: "packingChanged"; tripPlanId: string; balance?: number }
  /** Deleting is never done on the model's word alone; the user confirms. */
  | { type: "confirmDeleteWardrobeItem"; id: string; title: string };

export type AssistantEnvelope = { reply: string; actions: AssistantAction[] };
export type AssistantActionContext = {
  userId: string;
  scenarioIds: ReadonlySet<string>;
  wardrobe: WardrobeStore;
  tripPlans: TripPlanStore;
  packingPlans: PackingPlanStore;
  /** Resolve a place name to coordinates (Nominatim); null when unknown. */
  geocode: (
    placeName: string
  ) => Promise<{ placeName: string; placeDetail: string; lat: number; lon: number } | null>;
  /** Save the trip and queue the same Agent generation the form uses. */
  startTripGeneration: (plan: NewTripPlan) => Promise<unknown>;
  updateProfile: (values: ProfileValues) => AsyncValue<unknown>;
  currentProfile: () => AsyncValue<Record<string, unknown>>;
};

export type AssistantDataContext = AssistantActionContext & {
  promptContext: string;
};

const PAGE_SET = new Set<string>(ASSISTANT_PAGES);
const clean = (value: string, max: number) => value.trim().slice(0, max);

function strings(value: unknown, maxItems = 12): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return;
  return value.slice(0, maxItems).map((item) => clean(item, 80));
}

function wardrobeItem(raw: Record<string, unknown>): NewItem | null {
  if (typeof raw.title !== "string" || typeof raw.category !== "string") return null;
  const title = clean(raw.title, 120);
  const category = clean(raw.category, 80);
  if (!title || !category) return null;
  const count = typeof raw.count === "number" && Number.isInteger(raw.count) && raw.count > 0
    ? Math.min(raw.count, 99) : undefined;
  return {
    title,
    ...(typeof raw.titleEn === "string" ? { titleEn: clean(raw.titleEn, 120) } : {}),
    category,
    ...(typeof raw.subtype === "string" ? { subtype: clean(raw.subtype, 80) } : {}),
    ...(count ? { count } : {}),
    ...(strings(raw.colors) ? { colors: strings(raw.colors) } : {}),
    ...(typeof raw.fit === "string" ? { fit: clean(raw.fit, 80) } : {}),
    ...(typeof raw.material === "string" ? { material: clean(raw.material, 80) } : {}),
    ...(strings(raw.seasons) ? { seasons: strings(raw.seasons) } : {}),
    ...(strings(raw.styleTags) ? { styleTags: strings(raw.styleTags) } : {}),
    ...(typeof raw.details === "string" ? { details: clean(raw.details, 500) } : {}),
  };
}

function parseAction(raw: unknown): AssistantAction | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.type === "navigate" && typeof value.page === "string" && PAGE_SET.has(value.page)) {
    return {
      type: "navigate",
      page: value.page as AssistantPage,
      ...(typeof value.scenario === "string" ? { scenario: value.scenario } : {}),
    };
  }
  if (value.type === "updateProfile" && value.profile && typeof value.profile === "object") {
    return { type: "updateProfile", profile: value.profile as Record<string, unknown> };
  }
  if (value.type === "deleteWardrobeItem" && typeof value.id === "string") {
    return { type: "deleteWardrobeItem", id: value.id };
  }
  if (value.type === "packingChecklist") {
    const checked = strings(value.checked, 100);
    const unchecked = strings(value.unchecked, 100);
    const balance = typeof value.balance === "number" && Number.isFinite(value.balance)
      ? Math.max(0, Math.min(100, Math.round(value.balance))) : undefined;
    if (!checked && !unchecked && balance === undefined) return null;
    return { type: "packingChecklist", ...(checked ? { checked } : {}), ...(unchecked ? { unchecked } : {}), ...(balance !== undefined ? { balance } : {}) };
  }
  if (value.type === "updateWardrobeItem" && typeof value.id === "string" &&
      value.patch && typeof value.patch === "object") {
    const raw = value.patch as Record<string, unknown>;
    const patch: ItemPatch = {};
    if (typeof raw.title === "string") patch.title = clean(raw.title, 120);
    if (typeof raw.titleEn === "string") patch.titleEn = clean(raw.titleEn, 120);
    if (typeof raw.category === "string") patch.category = clean(raw.category, 80);
    // A misrecognised colour is the most common correction users ask for.
    if (strings(raw.colors)) patch.colors = strings(raw.colors);
    if (strings(raw.seasons)) patch.seasons = strings(raw.seasons);
    if (strings(raw.styleTags)) patch.styleTags = strings(raw.styleTags);
    if (typeof raw.subtype === "string") patch.subtype = clean(raw.subtype, 80);
    if (typeof raw.count === "number" && Number.isInteger(raw.count) && raw.count > 0) patch.count = Math.min(raw.count, 99);
    if (typeof raw.fit === "string") patch.fit = clean(raw.fit, 80);
    if (typeof raw.material === "string") patch.material = clean(raw.material, 80);
    if (typeof raw.details === "string") patch.details = clean(raw.details, 500);
    return Object.keys(patch).length ? { type: "updateWardrobeItem", id: value.id, patch } : null;
  }
  if (value.type === "addWardrobeItem" && value.item && typeof value.item === "object") {
    const item = wardrobeItem(value.item as Record<string, unknown>);
    return item ? { type: "addWardrobeItem", item } : null;
  }
  if (value.type !== "createTripPlan" || !value.plan || typeof value.plan !== "object") return null;
  const plan = value.plan as Record<string, unknown>;
  if (typeof plan.scenario !== "string" || typeof plan.placeName !== "string" ||
      typeof plan.startDate !== "string" || typeof plan.endDate !== "string") return null;
  return { type: "createTripPlan", plan: {
    scenario: plan.scenario, placeName: clean(plan.placeName, 200),
    startDate: plan.startDate, endDate: plan.endDate,
    ...(typeof plan.notes === "string" ? { notes: clean(plan.notes, 1200) } : {}),
  }};
}

/** Parse provider JSON; unknown actions degrade to an ordinary assistant reply. */
export function parseAssistantEnvelope(content: string): AssistantEnvelope {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  let raw: unknown;
  try { raw = JSON.parse((fenced ?? content).trim()); }
  catch { return { reply: content.trim(), actions: [] }; }
  if (!raw || typeof raw !== "object") return { reply: content.trim(), actions: [] };
  const envelope = raw as Record<string, unknown>;
  const actions = Array.isArray(envelope.actions)
    ? envelope.actions.map(parseAction).filter((a): a is AssistantAction => a !== null).slice(0, 5)
    : [];
  const reply = typeof envelope.reply === "string" && envelope.reply.trim()
    ? envelope.reply.trim() : "Done.";
  return { reply, actions };
}

export async function executeAssistantActions(
  actions: AssistantAction[], ctx: AssistantActionContext
): Promise<{ actions: ClientAssistantAction[]; errors: string[] }> {
  const completed: ClientAssistantAction[] = [];
  const errors: string[] = [];
  for (const action of actions) {
    if (action.type === "navigate") { completed.push(action); continue; }
    if (action.type === "updateProfile") {
      const profile = validateProfile({ ...(await ctx.currentProfile()), ...action.profile });
      if (profile.ok === false) { errors.push(profile.error); continue; }
      completed.push({ type: "profileUpdated", user: await ctx.updateProfile(profile.values) });
      continue;
    }
    if (action.type === "addWardrobeItem") {
      await ctx.wardrobe.add(ctx.userId, action.item);
      completed.push({ type: "wardrobeChanged" });
      continue;
    }
    if (action.type === "packingChecklist") {
      // Ticks are stored per trip on the server, so the assistant changes the
      // same checklist the web and iOS clients show (the latest generated one,
      // whose item ids are in the prompt context).
      const latest = await ctx.packingPlans.latest(ctx.userId);
      if (!latest) { errors.push("There is no packing list yet."); continue; }
      const known = packingItemIds(latest.packing);
      const valid = (ids?: string[]) => (ids ?? []).filter((id) => known.has(id));
      await ctx.packingPlans.setChecks(ctx.userId, latest.tripPlanId, valid(action.checked), true);
      await ctx.packingPlans.setChecks(ctx.userId, latest.tripPlanId, valid(action.unchecked), false);
      completed.push({
        type: "packingChanged",
        tripPlanId: latest.tripPlanId,
        ...(action.balance !== undefined ? { balance: action.balance } : {}),
      });
      continue;
    }
    if (action.type === "updateWardrobeItem") {
      if (!(await ctx.wardrobe.update(ctx.userId, action.id, action.patch))) errors.push("Wardrobe item not found.");
      else completed.push({ type: "wardrobeChanged" });
      continue;
    }
    if (action.type === "deleteWardrobeItem") {
      // A misread request must not silently destroy data: hand the deletion
      // to the client, which asks the user and then calls DELETE itself.
      const item = (await ctx.wardrobe.list(ctx.userId)).find((i) => i.id === action.id);
      if (!item) errors.push("Wardrobe item not found.");
      else completed.push({ type: "confirmDeleteWardrobeItem", id: item.id, title: item.title });
      continue;
    }
    // Same validation and the same generation job as the trip form. Model
    // coordinates were often approximate, so the place is geocoded instead.
    const place = await ctx.geocode(action.plan.placeName);
    if (!place) {
      errors.push(`Could not find "${action.plan.placeName}" on the map.`);
      continue;
    }
    const parsed = parseTripInput({ ...action.plan, ...place }, ctx.scenarioIds);
    if (parsed.ok === false) {
      errors.push(parsed.error);
      continue;
    }
    await ctx.startTripGeneration(parsed.plan);
    completed.push({ type: "tripCreated" }, { type: "navigate", page: "home" });
  }
  return { actions: completed, errors };
}
