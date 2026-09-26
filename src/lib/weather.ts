/**
 * Current conditions for one place, from Open-Meteo (free, no API key).
 *
 * The API route calls `fetchCurrentWeather` and the CDN caches its response,
 * so upstream traffic stays at roughly one request per cache window no
 * matter how many people load the page.
 */
import { z } from "astro/zod";

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export const SAN_FRANCISCO: Place = {
  name: "San Francisco",
  latitude: 37.7749,
  longitude: -122.4194,
  timezone: "America/Los_Angeles",
};

export type Sky =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "storm";

export interface CurrentWeather {
  place: string;
  timezone: string;
  temperatureF: number;
  windMph: number;
  sky: Sky;
  label: string;
  isDay: boolean;
  /** ISO timestamp of the observation, in UTC. */
  observedAt: string;
}

/** WMO weather interpretation codes, grouped into what the UI can draw. */
export function describeWeatherCode(code: number): { sky: Sky; label: string } {
  if (code === 0) return { sky: "clear", label: "Clear" };
  if (code === 1) return { sky: "partly-cloudy", label: "Mostly clear" };
  if (code === 2) return { sky: "partly-cloudy", label: "Partly cloudy" };
  if (code === 3) return { sky: "cloudy", label: "Overcast" };
  if (code === 45 || code === 48) return { sky: "fog", label: "Fog" };
  if (code >= 51 && code <= 57) return { sky: "drizzle", label: "Drizzle" };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82))
    return { sky: "rain", label: code >= 80 ? "Showers" : "Rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86)
    return { sky: "snow", label: "Snow" };
  if (code >= 95 && code <= 99) return { sky: "storm", label: "Thunderstorms" };
  return { sky: "cloudy", label: "Cloudy" };
}

const OpenMeteoCurrent = z.object({
  utc_offset_seconds: z.number(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    wind_speed_10m: z.number(),
    weather_code: z.number().int(),
    is_day: z.union([z.literal(0), z.literal(1)]),
  }),
});

export function parseOpenMeteo(place: Place, body: unknown): CurrentWeather {
  const data = OpenMeteoCurrent.parse(body);
  const { current } = data;
  // Open-Meteo returns local time without an offset; convert it to UTC.
  const localMs = Date.parse(`${current.time}:00Z`);
  const observedAt = new Date(
    localMs - data.utc_offset_seconds * 1000,
  ).toISOString();
  return {
    place: place.name,
    timezone: place.timezone,
    temperatureF: Math.round(current.temperature_2m),
    windMph: Math.round(current.wind_speed_10m),
    isDay: current.is_day === 1,
    observedAt,
    ...describeWeatherCode(current.weather_code),
  };
}

export async function fetchCurrentWeather(
  place: Place,
  fetcher: typeof fetch = fetch,
): Promise<CurrentWeather> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,weather_code,is_day,wind_speed_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: place.timezone,
  }).toString();

  const res = await fetcher(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
  return parseOpenMeteo(place, await res.json());
}
