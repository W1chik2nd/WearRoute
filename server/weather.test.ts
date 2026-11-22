import { test } from "node:test";
import assert from "node:assert/strict";
import { destinationForecast, forecastChanges } from "./weather.ts";
import type { ForecastDay, TripForecast } from "../shared/weather-types.ts";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Archive response: same weather every year, rainy on the 2nd of the month. */
function archive(url: URL) {
  const start = url.searchParams.get("start_date")!;
  const end = url.searchParams.get("end_date")!;
  const time: string[] = [];
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    time.push(d.toISOString().slice(0, 10));
  }
  return json({
    daily: {
      time,
      weather_code: time.map((t) => (t.endsWith("-02") ? 61 : 1)),
      temperature_2m_max: time.map(() => 20),
      temperature_2m_min: time.map(() => 10),
      precipitation_sum: time.map((t) => (t.endsWith("-02") ? 6 : 0)),
      wind_speed_10m_max: time.map(() => 12),
    },
  });
}

test("dates beyond the forecast window get typical weather, clearly marked", async (t) => {
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requested.push(url.hostname);
    if (url.hostname === "archive-api.open-meteo.com") return archive(url);
    throw new Error(`unexpected ${url}`);
  });

  const forecast = await destinationForecast(48.85, 2.35, "2026-12-01", "2026-12-02", "2026-09-01");
  assert.ok(!requested.includes("api.open-meteo.com"), "no forecast call far outside its window");
  assert.equal(forecast.available, true);
  assert.deepEqual(forecast.days.map((d) => [d.date, d.basis, d.precipitationProbability, d.uvIndex]), [
    ["2026-12-01", "typical", 0, null],
    ["2026-12-02", "typical", 100, null],
  ]);
  assert.equal(forecast.days[1].condition, "Rain");
  assert.match(forecast.note, /not a forecast/);
});

test("a trip straddling the window mixes live and typical days in date order", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "archive-api.open-meteo.com") return archive(url);
    assert.equal(url.searchParams.get("end_date"), "2026-09-16", "forecast request stops at the window");
    return json({
      daily: {
        time: ["2026-09-15", "2026-09-16"],
        weather_code: [0, 3],
        temperature_2m_max: [25, 24],
        temperature_2m_min: [15, 14],
        precipitation_probability_max: [5, 10],
        uv_index_max: [6, 5],
        wind_speed_10m_max: [10, 11],
      },
    });
  });
  const forecast = await destinationForecast(35.01, 135.77, "2026-09-15", "2026-09-18", "2026-09-01");
  assert.deepEqual(forecast.days.map((d) => [d.date, d.basis]), [
    ["2026-09-15", "forecast"],
    ["2026-09-16", "forecast"],
    ["2026-09-17", "typical"],
    ["2026-09-18", "typical"],
  ]);
});

const day = (date: string, rain: number, max: number, basis: ForecastDay["basis"] = "forecast"): ForecastDay => ({
  date, basis, condition: "Clear", minTempC: max - 8, maxTempC: max,
  precipitationProbability: rain, uvIndex: null, maxWindKph: 10,
});
const forecastOf = (days: ForecastDay[]): TripForecast => ({ source: "Open-Meteo", available: true, note: "", days });

test("forecast changes since planning are reported only when they matter", () => {
  const planned = forecastOf([day("2026-09-01", 10, 22, "typical"), day("2026-09-02", 70, 20), day("2026-09-03", 20, 18)]);
  const now = forecastOf([day("2026-09-01", 80, 22), day("2026-09-02", 30, 21), day("2026-09-03", 30, 25)]);
  assert.deepEqual(forecastChanges(planned, now), [
    { date: "2026-09-01", kind: "rain", before: 10, after: 80 },
    { date: "2026-09-02", kind: "dry", before: 70, after: 30 },
    { date: "2026-09-03", kind: "warmer", before: 18, after: 25 },
  ]);
  assert.deepEqual(forecastChanges(null, now), [], "older plans recorded no snapshot");
});
