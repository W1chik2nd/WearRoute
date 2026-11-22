// Typical weather for dates beyond the forecast window.
//
// Forecast providers reach about 16 days ahead, but most trips are planned
// further out. Previously those trips got no weather at all and the agent
// fell back to generic "conservative layers". For such dates this returns the
// average of the same calendar days over the last few years from Open-Meteo's
// historical archive, clearly marked basis: "typical" so no one mistakes it
// for a forecast.
import type { ForecastDay } from "../shared/weather-types.ts";
import { cached, describeWmo, providerFetch, WEATHER_USER_AGENT } from "./weather-providers.ts";

const YEARS = 3;
const NORMALS_TTL_MS = 24 * 60 * 60 * 1_000;
const WET_DAY_MM = 1;

type ArchiveDay = { max: number; min: number; rainMm: number; code: number; windKph: number };

function shiftYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  // Feb 29 in a non-leap year rolls to Mar 1, which is still the right season.
  const date = new Date(Date.UTC(y - years, m - 1, d));
  return date.toISOString().slice(0, 10);
}

async function archiveYear(
  lat: number,
  lon: number,
  start: string,
  end: string
): Promise<Map<string, ArchiveDay>> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: start,
    end_date: end,
    timezone: "auto",
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "wind_speed_10m_max",
    ].join(","),
  });
  const response = await providerFetch(
    `https://archive-api.open-meteo.com/v1/archive?${params}`,
    { "User-Agent": WEATHER_USER_AGENT }
  );
  if (!response.ok) throw new Error(`Open-Meteo archive failed (${response.status})`);
  const daily = ((await response.json()) as { daily?: Record<string, unknown[]> }).daily;
  const byMonthDay = new Map<string, ArchiveDay>();
  const time = daily?.time ?? [];
  time.forEach((date, i) => {
    const max = daily?.temperature_2m_max?.[i];
    const min = daily?.temperature_2m_min?.[i];
    if (typeof date !== "string" || typeof max !== "number" || typeof min !== "number") return;
    byMonthDay.set(date.slice(5), {
      max,
      min,
      rainMm: Number(daily?.precipitation_sum?.[i] ?? 0) || 0,
      code: Number(daily?.weather_code?.[i] ?? -1),
      windKph: Number(daily?.wind_speed_10m_max?.[i] ?? 0) || 0,
    });
  });
  return byMonthDay;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const round1 = (value: number) => Math.round(value * 10) / 10;

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

/** Typical days for `dates` (ascending ISO dates); throws if no year loads. */
export async function typicalDays(
  lat: number,
  lon: number,
  dates: string[]
): Promise<ForecastDay[]> {
  if (dates.length === 0) return [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  const key = `normals:${lat.toFixed(2)},${lon.toFixed(2)}:${first}:${last}`;
  return cached(key, NORMALS_TTL_MS, async () => {
    const years = (
      await Promise.allSettled(
        Array.from({ length: YEARS }, (_, i) =>
          archiveYear(lat, lon, shiftYears(first, i + 1), shiftYears(last, i + 1))
        )
      )
    )
      .filter((r): r is PromiseFulfilledResult<Map<string, ArchiveDay>> => r.status === "fulfilled")
      .map((r) => r.value);
    if (years.length === 0) throw new Error("Historical weather is unavailable.");

    return dates.flatMap((date): ForecastDay[] => {
      const monthDay = date.slice(5);
      const samples = years
        .map((year) => year.get(monthDay) ?? (monthDay === "02-29" ? year.get("02-28") : undefined))
        .filter((day): day is ArchiveDay => Boolean(day));
      if (samples.length === 0) return [];
      const wetShare = samples.filter((day) => day.rainMm >= WET_DAY_MM).length / samples.length;
      return [{
        date,
        basis: "typical",
        condition: mostCommon(samples.map((day) => describeWmo(day.code))),
        minTempC: round1(mean(samples.map((day) => day.min))),
        maxTempC: round1(mean(samples.map((day) => day.max))),
        precipitationProbability: Math.round(wetShare * 100),
        uvIndex: null,
        maxWindKph: round1(mean(samples.map((day) => day.windKph))),
      }];
    });
  });
}
