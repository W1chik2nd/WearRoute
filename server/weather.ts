// Client-facing weather contract. Provider selection, caching, retry, and
// failover stay behind this module so web and iOS share identical behaviour.

import {
  addIsoDays,
  isoDateRange,
  tripDaysInclusive,
} from "../shared/trip-constraints.ts";
import type {
  ForecastDay,
  TripForecast,
  TripWeather,
  Weather,
  WeatherChange,
} from "../shared/weather-types.ts";
import {
  loadCurrentWeather,
  loadDestinationForecast,
} from "./weather-providers.ts";
import { typicalDays } from "./weather-normals.ts";

export type {
  ForecastDay,
  TripForecast,
  TripWeather,
  Weather,
  WeatherChange,
} from "../shared/weather-types.ts";
export { DEFAULT_COORDS } from "./weather-providers.ts";

/** Open-Meteo forecasts today plus 15 days. */
const FORECAST_WINDOW_DAYS = 16;

export function currentWeather(lat: number, lon: number): Promise<Weather> {
  return loadCurrentWeather(lat, lon);
}

/**
 * Every trip date gets weather: a live forecast where providers reach, and
 * typical weather for the same calendar dates elsewhere. Each day says which
 * it is (`basis`), so a multi-year average is never presented as a forecast.
 */
export async function destinationForecast(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
  today = new Date().toISOString().slice(0, 10)
): Promise<TripForecast> {
  const lastForecastDate = addIsoDays(today, FORECAST_WINDOW_DAYS - 1);
  const live =
    startDate <= lastForecastDate
      ? await loadDestinationForecast(
          lat,
          lon,
          startDate,
          endDate < lastForecastDate ? endDate : lastForecastDate
        )
      : null;
  const liveDays = live?.available ? live.days : [];
  const covered = new Set(liveDays.map((day) => day.date));
  // Also fills dates a backup provider could not reach (MET ~9 days).
  const missing = isoDateRange(startDate, endDate).filter((date) => !covered.has(date));
  const typical = await typicalDays(lat, lon, missing).catch((error) => {
    console.warn(`[weather] ${String(error)}`);
    return [] as ForecastDay[];
  });
  const days = [...liveDays, ...typical].sort((a, b) => a.date.localeCompare(b.date));

  const notes = [
    liveDays.length > 0 ? `Live forecast from ${live!.source} for ${liveDays.length} day(s).` : "",
    typical.length > 0
      ? `Typical weather (average of the last 3 years for these dates) for ${typical.length} day(s); not a forecast — check again closer to departure.`
      : "",
  ].filter(Boolean);
  return {
    source: live?.available ? live.source : "Open-Meteo",
    available: days.length > 0,
    note:
      notes.join(" ") ||
      "Weather providers are temporarily unavailable for these dates.",
    days,
  };
}

const RAIN_THRESHOLD = 50;
const TEMPERATURE_SWING_C = 5;

/**
 * Days whose live forecast now differs from what the outfits were planned
 * against: rain chance crossing 50% either way, or a 5 °C+ change in the high.
 * Only live forecasts are compared; typical-vs-typical cannot "change".
 */
export function forecastChanges(
  planned: TripForecast | null,
  current: TripForecast
): WeatherChange[] {
  if (!planned) return [];
  const before = new Map(planned.days.map((day) => [day.date, day]));
  return current.days.flatMap((now): WeatherChange[] => {
    const then = before.get(now.date);
    if (!then || now.basis !== "forecast") return [];
    const changes: WeatherChange[] = [];
    const wasWet = then.precipitationProbability >= RAIN_THRESHOLD;
    const isWet = now.precipitationProbability >= RAIN_THRESHOLD;
    if (wasWet !== isWet) {
      changes.push({
        date: now.date,
        kind: isWet ? "rain" : "dry",
        before: Math.round(then.precipitationProbability),
        after: Math.round(now.precipitationProbability),
      });
    }
    const swing = now.maxTempC - then.maxTempC;
    if (Math.abs(swing) >= TEMPERATURE_SWING_C) {
      changes.push({
        date: now.date,
        kind: swing > 0 ? "warmer" : "colder",
        before: Math.round(then.maxTempC),
        after: Math.round(now.maxTempC),
      });
    }
    return changes;
  });
}

export async function weatherForTrip(
  plan: {
    id: string;
    placeName: string;
    placeDetail: string;
    lat: number;
    lon: number;
    startDate: string;
    endDate: string;
  },
  planned: TripForecast | null = null
): Promise<TripWeather> {
  const forecast = await destinationForecast(
    plan.lat,
    plan.lon,
    plan.startDate,
    plan.endDate
  );
  return {
    trip: {
      id: plan.id,
      destination: plan.placeName,
      destinationDetail: plan.placeDetail,
      startDate: plan.startDate,
      endDate: plan.endDate,
      dayCount: tripDaysInclusive(plan.startDate, plan.endDate),
    },
    forecast,
    changes: forecastChanges(planned, forecast),
  };
}
