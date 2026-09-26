import type { APIRoute } from "astro";
import { SAN_FRANCISCO, fetchCurrentWeather } from "@/lib/weather";

// Runs on demand as a Netlify Function.
export const prerender = false;

// Browsers keep a copy for 5 minutes. Netlify's CDN shares one copy across all
// visitors for 10 minutes and keeps serving it for up to an hour while it
// refreshes in the background, so a slow or failing upstream is never on the
// request path once the cache is warm.
const CACHE_HEADERS = {
  "cache-control": "public, max-age=300",
  "netlify-cdn-cache-control":
    "public, durable, s-maxage=600, stale-while-revalidate=3600",
};

export const GET: APIRoute = async () => {
  try {
    const weather = await fetchCurrentWeather(SAN_FRANCISCO);
    return new Response(JSON.stringify(weather), {
      headers: { "content-type": "application/json", ...CACHE_HEADERS },
    });
  } catch (err) {
    console.error("weather fetch failed", err);
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 502,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }
};
