import type { APIRoute } from "astro";
import {
  ViewCounter,
  hashVisitor,
  memoryStore,
  netlifyStore,
  normalizePath,
  shouldCount,
} from "@/lib/views";

// Runs on demand as a Netlify Function; everything else on the site is static.
export const prerender = false;

// The store handle is resolved per request so it always reflects the current
// Blobs environment; creating one is cheap. The memory fallback is for
// `astro dev` only: in production it would report numbers that vanish on
// the next cold start.
const fallback = memoryStore();
let warnedAboutStore = false;
function counter(): ViewCounter | null {
  const store = netlifyStore();
  if (store) return new ViewCounter(store);
  if (!import.meta.env.PROD) return new ViewCounter(fallback);
  if (!warnedAboutStore) {
    warnedAboutStore = true;
    console.error("Netlify Blobs is unavailable; view counter is off.");
  }
  return null;
}

/** Error detail in local dev only; production responses stay generic. */
const devDetail = (err: unknown) =>
  import.meta.env.DEV ? { detail: String(err) } : {};

const NO_STORE = { "cache-control": "no-store" };
// A minute-old total is fine for the public read, and Netlify's CDN then
// answers repeat GETs without touching Blobs.
const CDN_CACHE = {
  "cache-control": "public, max-age=0",
  "netlify-cdn-cache-control": "public, s-maxage=60",
};

const json = (body: unknown, status = 200, cache = NO_STORE) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cache },
  });

const unavailable = () => json({ error: "unavailable" }, 503);

export const GET: APIRoute = async () => {
  const views = counter();
  if (!views) return unavailable();
  try {
    return json(await views.read(), 200, CDN_CACHE);
  } catch (err) {
    console.error("view counter read failed", err);
    return json({ error: "unavailable", ...devDetail(err) }, 503);
  }
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const views = counter();
  if (!views) return unavailable();
  try {
    // Automated traffic still gets the numbers, it just does not move them.
    if (!shouldCount(request.headers)) return json(await views.read());

    const body = await request.json().catch(() => null);
    const path = normalizePath(body?.path);

    // Netlify sets the connection IP itself; it cannot be spoofed by the client.
    const ip =
      request.headers.get("x-nf-client-connection-ip") ??
      clientAddress ??
      "unknown";
    const ua = request.headers.get("user-agent") ?? "";
    const visitor = await hashVisitor(ip, ua);
    if (!visitor) return json(await views.read());
    return json(await views.record(visitor, path));
  } catch (err) {
    console.error("view counter write failed", err);
    return json({ error: "unavailable", ...devDetail(err) }, 503);
  }
};
