/**
 * Weather for the dashboard band, from Open-Meteo (no key). A port of Homedash's
 * resolve_location / fetch_weather: geocode the place once (or use pinned coordinates), then
 * fetch today's forecast. Injectable fetch so tests never touch the network.
 */

export type FetchJson = (url: string) => Promise<any>;
export interface Weather { temp: number; condition: string; high: number; low: number; sunrise: string; sunset: string; sunriseMin: number; sunsetMin: number; place: string }

export const WMO: Record<number, string> = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
};

export const defaultFetchJson: FetchJson = async (u) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Open-Meteo answered ${r.status}`);
  return r.json();
};

/** null when no place is set; throws "no geocoding match for 'X'" when the place isn't found. */
export async function resolveLocation(w: { place: string; lat: number | null; lon: number | null }, fetchJson: FetchJson): Promise<{ lat: number; lon: number; label: string } | null> {
  if (w.lat !== null && w.lat !== undefined && w.lon !== null && w.lon !== undefined) return { lat: Number(w.lat), lon: Number(w.lon), label: w.place || "" };
  const place = (w.place || "").trim();
  if (!place) return null;
  const q = encodeURIComponent(place.split(",")[0].trim());
  const found = (await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1`))?.results;
  if (!Array.isArray(found) || !found.length) throw new Error(`no geocoding match for '${place}'`);
  const hit = found[0];
  return { lat: hit.latitude, lon: hit.longitude, label: hit.name ?? place };
}

export function clock12(h: number, m: number): string {
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "2026-10-20T07:12" is already the place's local time (timezone=auto): split it, don't parse it as UTC. */
function hm(iso: unknown): [number, number] {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso));
  if (!m) throw new Error(`Open-Meteo's answer was missing a readable sun time (got ${JSON.stringify(iso)})`);
  return [Number(m[1]), Number(m[2])];
}

export async function fetchWeather(lat: number, lon: number, unit: string, fetchJson: FetchJson): Promise<Omit<Weather, "place">> {
  const url = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`
    + "&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset"
    + `&temperature_unit=${unit}&timezone=auto&forecast_days=1`;
  const data = await fetchJson(url);
  const cur = data?.current, day = data?.daily;
  if (!cur || !day || !Array.isArray(day.sunrise) || !Array.isArray(day.sunset)) throw new Error("Open-Meteo's answer was missing the current or daily forecast");
  const [rh, rm] = hm(day.sunrise[0]);
  const [sh, sm] = hm(day.sunset[0]);
  return {
    temp: Math.round(cur.temperature_2m), condition: WMO[cur.weather_code] ?? "Unknown",
    high: Math.round(day.temperature_2m_max[0]), low: Math.round(day.temperature_2m_min[0]),
    sunrise: clock12(rh, rm), sunset: clock12(sh, sm), sunriseMin: rh * 60 + rm, sunsetMin: sh * 60 + sm,
  };
}
