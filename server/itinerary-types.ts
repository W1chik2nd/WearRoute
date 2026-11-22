// Itinerary data contracts shared by the SQLite and PostgreSQL stores.
// Split from itinerary.ts to keep each file under 400 lines (AGENTS.md §7).
import type { BilingualItem } from "./trip-agent-types.ts";
import type { AsyncValue } from "./async-value.ts";

/** 停靠点类型:景点 / 交通 / 餐饮 / 住宿。右侧时间轴按类型换图标。 */
export type StopKind = "spot" | "transit" | "meal" | "hotel";

export type TripStop = {
  id: string;
  position: number;
  kind: StopKind;
  name: string;
  /** 英文名,供语言切换用;API 保持语言中立(AGENTS.md §3)。 */
  nameEn: string;
  startTime: string;
  duration: string;
  note: string;
  noteEn: string;
  photoQuery: string;
  /** 已解析的配图;null 表示还没查过或查不到。 */
  photoUrl: string | null;
  photoCredit: string | null;
  photoSourceUrl: string | null;
};

export type TripDay = {
  id: string;
  /** 第几天,从 1 开始。 */
  dayNumber: number;
  /** 手绘图里的 "x.xx" —— 显示用日期文本,如 "3.14"。 */
  dateLabel: string;
  city: string;
  cityEn: string;
  /** 当天主题一句话。 */
  summary: string;
  summaryEn: string;
  weatherSummary: string;
  weatherSummaryEn: string;
  weatherRisk: string;
  weatherRiskEn: string;
  outfit: BilingualItem[];
  equipment: BilingualItem[];
  stops: TripStop[];
};

export type Trip = {
  id: string;
  title: string;
  titleEn: string;
  /** 对应场景 id(commute/travel/business…),来自场景选择页。 */
  scenario: string;
  /** 出发日期文本,手绘图左上角的 "x.xx 出发"。 */
  departLabel: string;
  createdAt: string;
  sourcePlanId: string | null;
  days: TripDay[];
};

/** 配图解析结果,来自 photos.ts。 */
export type PhotoPatch = {
  photoUrl: string;
  photoCredit: string;
  photoSourceUrl: string;
};

/**
 * 停靠点 + 它所在那天的城市。配图关键词要用城市来消歧
 * (「宽窄巷子」加上「成都」命中率明显更高),所以配图路由取的是这个类型。
 */
export type StopWithCity = TripStop & {
  city: string;
  cityEn: string;
  /** When a lookup last found no photo (epoch ms); null if never or found. */
  photoMissingAt: number | null;
};

export type ItineraryStore = {
  /** 某用户的全部行程(含天与停靠点)。 */
  list: (userId: string) => AsyncValue<Trip[]>;
  get: (userId: string, tripId: string) => AsyncValue<Trip | null>;
  /** 造一份演示行程并返回。UI 阶段用,接入 AI 生成后废弃。 */
  seedDemoTrip: (userId: string, scenario: string) => AsyncValue<Trip>;
  /** 把查到的配图写回停靠点,下次不用再查供应商。 */
  setStopPhoto: (userId: string, stopId: string, photo: PhotoPatch) => AsyncValue<void>;
  /** Remember that no library had a photo, so the lookup is not repeated on every view. */
  markStopPhotoMissing: (userId: string, stopId: string, at: number) => AsyncValue<void>;
  /** 取停靠点(带用户校验、带所在城市),供配图路由用。 */
  stop: (userId: string, stopId: string) => AsyncValue<StopWithCity | null>;
};

export type SyncItineraryStore = {
  list: (userId: string) => Trip[];
  get: (userId: string, tripId: string) => Trip | null;
  seedDemoTrip: (userId: string, scenario: string) => Trip;
  setStopPhoto: (userId: string, stopId: string, photo: PhotoPatch) => void;
  markStopPhotoMissing: (userId: string, stopId: string, at: number) => void;
  stop: (userId: string, stopId: string) => StopWithCity | null;
};
