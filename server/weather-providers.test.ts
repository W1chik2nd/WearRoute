import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadCurrentWeather,
  loadDestinationForecast,
} from "./weather-providers.ts";

function metResponse(timeseries: unknown[]) {
  return new Response(JSON.stringify({ properties: { timeseries } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("Open-Meteo 429 falls back to MET Norway and caches current weather", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.includes("open-meteo.com")) return new Response("", { status: 429 });
    return metResponse([
      {
        time: "2026-08-25T00:00:00Z",
        data: {
          instant: { details: { air_temperature: 26.4 } },
          next_1_hours: { summary: { symbol_code: "partlycloudy_day" } },
        },
      },
    ]);
  });

  const first = await loadCurrentWeather(22.3193, 114.1694);
  const second = await loadCurrentWeather(22.3193, 114.1694);

  assert.deepEqual(first, { tempC: 26.4, condition: "Partly cloudy" });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2, "second request should be served by the cache");
  assert.match(calls[0], /open-meteo/);
  assert.match(calls[1], /api\.met\.no/);
});

test("trip forecast falls back without misreporting a 429 as a date error", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("open-meteo.com")) return new Response("", { status: 429 });
    return metResponse([
      {
        time: "2026-08-26T00:00:00Z",
        data: {
          instant: {
            details: {
              air_temperature: 25,
              wind_speed: 3,
              ultraviolet_index_clear_sky: 0,
            },
          },
          next_1_hours: {
            summary: { symbol_code: "partlycloudy_day" },
            details: { precipitation_amount: 0 },
          },
        },
      },
      {
        time: "2026-08-26T06:00:00Z",
        data: {
          instant: {
            details: {
              air_temperature: 31,
              wind_speed: 5,
              ultraviolet_index_clear_sky: 6.2,
            },
          },
          next_1_hours: {
            summary: { symbol_code: "rainshowers_day" },
            details: { precipitation_amount: 1.2 },
          },
        },
      },
      {
        time: "2026-08-27T00:00:00Z",
        data: {
          instant: {
            details: {
              air_temperature: 24,
              wind_speed: 2,
              ultraviolet_index_clear_sky: 1.1,
            },
          },
          next_1_hours: {
            summary: { symbol_code: "clearsky_day" },
            details: { precipitation_amount: 0 },
          },
        },
      },
    ]);
  });

  const forecast = await loadDestinationForecast(
    31.2304,
    121.4737,
    "2026-08-26",
    "2026-08-27"
  );

  assert.equal(forecast.available, true);
  assert.equal(forecast.source, "MET Norway");
  assert.equal(forecast.days.length, 2);
  assert.deepEqual(forecast.days[0], {
    date: "2026-08-26",
    basis: "forecast",
    condition: "Showers",
    minTempC: 25,
    maxTempC: 31,
    precipitationProbability: 80,
    uvIndex: 6.2,
    maxWindKph: 18,
  });
});

test("backup forecast groups hours by the destination's day, not UTC's", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("open-meteo.com")) return new Response("", { status: 503 });
    // 20:00 UTC on the 26th is 05:00 on the 27th in Tokyo.
    return metResponse([
      {
        time: "2026-08-26T20:00:00Z",
        data: {
          instant: { details: { air_temperature: 27, wind_speed: 2 } },
          next_1_hours: { summary: { symbol_code: "clearsky_day" }, details: { precipitation_amount: 0 } },
        },
      },
    ]);
  });
  t.mock.method(console, "warn", () => {});
  const forecast = await loadDestinationForecast(35.68, 139.69, "2026-08-27", "2026-08-27");
  assert.equal(forecast.available, true);
  assert.deepEqual(forecast.days.map((d) => d.date), ["2026-08-27"]);
});
