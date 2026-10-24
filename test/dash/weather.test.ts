import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocation, fetchWeather, clock12 } from "../../src/dash/weather";

const forecast = {
  current: { temperature_2m: 61.6, weather_code: 61 },
  daily: { temperature_2m_max: [70.4], temperature_2m_min: [40.5], sunrise: ["2026-10-20T07:12"], sunset: ["2026-10-20T18:05"] },
};

test("pinned lat/lon skip geocoding", async () => {
  const calls: string[] = [];
  const loc = await resolveLocation({ place: "Sterling, CO", lat: 40.6, lon: -103.2 }, async (u) => { calls.push(u); return {}; });
  assert.deepEqual(loc, { lat: 40.6, lon: -103.2, label: "Sterling, CO" });
  assert.deepEqual(calls, []);
});

test("an empty place is no location (the band says so), not an error", async () => {
  assert.equal(await resolveLocation({ place: "  ", lat: null, lon: null }, async () => ({})), null);
});

test("geocoding uses the part before the comma; no match says which place", async () => {
  const calls: string[] = [];
  const loc = await resolveLocation({ place: "Sterling, CO", lat: null, lon: null }, async (u) => {
    calls.push(u);
    return { results: [{ latitude: 40.6, longitude: -103.2, name: "Sterling" }] };
  });
  assert.deepEqual(loc, { lat: 40.6, lon: -103.2, label: "Sterling" });
  assert.match(calls[0], /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=Sterling&count=1$/);
  await assert.rejects(resolveLocation({ place: "Nowhereville", lat: null, lon: null }, async () => ({ results: [] })), /no geocoding match for 'Nowhereville'/);
});

test("forecast parsing: WMO text, rounding, 12-hour sun times and minutes after midnight", async () => {
  let url = "";
  const w = await fetchWeather(40.6, -103.2, "fahrenheit", async (u) => { url = u; return forecast; });
  assert.match(url, /latitude=40\.6&longitude=-103\.2&.*temperature_unit=fahrenheit&timezone=auto&forecast_days=1/);
  assert.deepEqual(w, { temp: 62, condition: "Light rain", high: 70, low: 41, sunrise: "7:12 AM", sunset: "6:05 PM", sunriseMin: 432, sunsetMin: 1085 });
  assert.equal(clock12(0, 5), "12:05 AM");
  assert.equal(clock12(12, 0), "12:00 PM");
});

test("an unknown weather code says Unknown; a malformed answer is a plain error", async () => {
  const w = await fetchWeather(1, 2, "celsius", async () => ({ ...forecast, current: { temperature_2m: 1, weather_code: 4242 } }));
  assert.equal(w.condition, "Unknown");
  await assert.rejects(fetchWeather(1, 2, "celsius", async () => ({ nope: true })), /Open-Meteo's answer was missing/);
});
