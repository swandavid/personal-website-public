import { describe, expect, it } from "vitest";
import {
  SAN_FRANCISCO,
  describeWeatherCode,
  fetchCurrentWeather,
  parseOpenMeteo,
} from "./weather";

const sample = {
  utc_offset_seconds: -25200, // PDT
  current: {
    time: "2026-09-21T09:45",
    temperature_2m: 61.6,
    wind_speed_10m: 11.2,
    weather_code: 3,
    is_day: 1,
  },
};

describe("describeWeatherCode", () => {
  it.each([
    [0, "clear"],
    [2, "partly-cloudy"],
    [3, "cloudy"],
    [45, "fog"],
    [53, "drizzle"],
    [63, "rain"],
    [81, "rain"],
    [73, "snow"],
    [95, "storm"],
    [999, "cloudy"],
  ] as const)("maps %i to %s", (code, sky) => {
    expect(describeWeatherCode(code).sky).toBe(sky);
  });
});

describe("parseOpenMeteo", () => {
  it("rounds values and converts local time to UTC", () => {
    expect(parseOpenMeteo(SAN_FRANCISCO, sample)).toEqual({
      place: "San Francisco",
      timezone: "America/Los_Angeles",
      temperatureF: 62,
      windMph: 11,
      sky: "cloudy",
      label: "Overcast",
      isDay: true,
      observedAt: "2026-09-21T16:45:00.000Z",
    });
  });

  it("rejects a response with a missing field", () => {
    const broken = { ...sample, current: { ...sample.current } } as Record<
      string,
      unknown
    >;
    delete (broken.current as Record<string, unknown>).temperature_2m;
    expect(() => parseOpenMeteo(SAN_FRANCISCO, broken)).toThrow();
  });
});

describe("fetchCurrentWeather", () => {
  it("requests Fahrenheit for the place's coordinates", async () => {
    let requested = "";
    const fake = (async (url: URL) => {
      requested = url.toString();
      return new Response(JSON.stringify(sample));
    }) as unknown as typeof fetch;
    await fetchCurrentWeather(SAN_FRANCISCO, fake);
    expect(requested).toContain("latitude=37.7749");
    expect(requested).toContain("temperature_unit=fahrenheit");
  });

  it("throws on an upstream error", async () => {
    const fake = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchCurrentWeather(SAN_FRANCISCO, fake)).rejects.toThrow(
      /500/,
    );
  });
});
