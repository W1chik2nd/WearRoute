/** Canonical garment kind, decided once on the server (server/wardrobe-kind.ts). */
export type WardrobeKind = "top" | "pants" | "skirt" | "shoes" | "accessory";

export type WardrobeItem = {
  id: string;
  title: string;
  /** English headline from recognition; empty for items saved before it existed. */
  titleEn: string;
  category: string;
  subtype: string;
  count: number;
  colors: string[];
  fit: string;
  material: string;
  seasons: string[];
  styleTags: string[];
  details: string;
  hasPhoto: boolean;
  createdAt: string;
};
