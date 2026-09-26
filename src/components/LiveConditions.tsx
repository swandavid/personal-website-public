import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Moon,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type { CurrentWeather, Sky } from "@/lib/weather";

const TIMEZONE = "America/Los_Angeles";
const REFRESH_MS = 10 * 60 * 1000;

// ---- Clock -----------------------------------------------------------------
// Read through useSyncExternalStore so the server render (build time) shows
// no time at all instead of a stale one that mismatches on hydration.
const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hour: "numeric",
  minute: "2-digit",
});
const subscribeToClock = (tick: () => void) => {
  const id = setInterval(tick, 15_000);
  return () => clearInterval(id);
};
const getTime = () => timeFormat.format(new Date());
const getServerTime = () => null;

// ---- Weather ---------------------------------------------------------------
const ICONS: Record<Sky, [day: LucideIcon, night: LucideIcon]> = {
  clear: [Sun, Moon],
  "partly-cloudy": [CloudSun, CloudMoon],
  cloudy: [Cloud, Cloud],
  fog: [CloudFog, CloudFog],
  drizzle: [CloudDrizzle, CloudDrizzle],
  rain: [CloudRain, CloudRain],
  snow: [CloudSnow, CloudSnow],
  storm: [CloudLightning, CloudLightning],
};

function useWeather(): CurrentWeather | null {
  const [weather, setWeather] = useState<CurrentWeather | null>(null);

  useEffect(() => {
    let lastFetch = 0;
    let cancelled = false;

    const load = async () => {
      lastFetch = Date.now();
      try {
        const res = await fetch("/api/weather");
        if (!res.ok) return;
        const data = (await res.json()) as CurrentWeather;
        if (!cancelled) setWeather(data);
      } catch {
        // Decorative; keep whatever we last showed.
      }
    };

    // Refresh on a timer while the tab is visible, and catch up on return.
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetch >= REFRESH_MS) void load();
    };
    void load();
    const id = setInterval(maybeRefresh, 60_000);
    document.addEventListener("visibilitychange", maybeRefresh);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", maybeRefresh);
    };
  }, []);

  return weather;
}

/** "Live" strip: San Francisco local time and current weather. */
export default function LiveConditions() {
  const time = useSyncExternalStore(subscribeToClock, getTime, getServerTime);
  const weather = useWeather();
  const Icon = weather ? ICONS[weather.sky][weather.isDay ? 0 : 1] : null;

  return (
    <p className="text-ink-faint flex min-h-5 flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono text-xs tracking-wider uppercase md:justify-start">
      <span className="relative flex size-2" aria-hidden="true">
        <span className="bg-accent absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden" />
        <span className="bg-accent relative inline-flex size-2 rounded-full" />
      </span>
      <span className="text-ink-muted">San Francisco</span>
      <span
        className={`tabular-nums transition-opacity duration-500 ${time ? "opacity-100" : "opacity-0"}`}
      >
        {time ?? "--:-- --"}
      </span>
      {weather && Icon && (
        <span
          className="animate-in-fade inline-flex items-center gap-1.5"
          title={`${weather.label}, wind ${weather.windMph} mph`}
        >
          <Icon className="text-ink-muted size-3.5" aria-hidden="true" />
          <span className="text-ink-muted tabular-nums">
            {weather.temperatureF}°F
          </span>
          {/* Phones keep the strip to one line: icon and temperature only. */}
          <span className="hidden sm:inline">{weather.label}</span>
        </span>
      )}
    </p>
  );
}
