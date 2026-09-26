/**
 * Site-wide view counter.
 *
 * Design notes:
 * - "Views" counts page loads, deduplicated server-side to one per visitor
 *   per path per VIEW_WINDOW_MS. That stops reload loops and casual repeats;
 *   a client that rotates its IP or user agent is a new visitor each time.
 * - "Unique viewers" counts distinct visitors. A visitor is a salted SHA-256
 *   of IP + user agent. No cookies, no raw IPs stored, and the salt never
 *   leaves the server.
 * - Storage is a tiny key-value contract (`CounterStore`). Netlify Blobs
 *   backs it in production; an in-memory map backs it in `astro dev` and in
 *   tests. Both support compare-and-set via etags, which is what makes the
 *   counter safe under concurrent requests. Netlify Blobs has no atomic
 *   increment, so the counter uses optimistic concurrency with retry.
 */
import { getStore } from "@netlify/blobs";

export interface ViewCounts {
  views: number;
  unique: number;
}

export interface Versioned<T> {
  value: T;
  etag: string;
}

export type WriteCondition = { onlyIfNew: true } | { onlyIfMatch: string };

/** The subset of a key-value store the counter needs. */
export interface CounterStore {
  getJSON<T>(key: string): Promise<Versioned<T> | null>;
  /** Resolves to `true` when the write happened, `false` when the condition failed. */
  setJSON(
    key: string,
    value: unknown,
    condition?: WriteCondition,
  ): Promise<boolean>;
}

const ZERO: ViewCounts = { views: 0, unique: 0 };
const COUNTS_KEY = "counts";
const VISITOR_PREFIX = "visitor/";
/** A repeat load of the same page inside this window is not a new view. */
export const VIEW_WINDOW_MS = 30 * 60 * 1000;
/** Per-visitor path history is capped so a single record cannot grow unbounded. */
const MAX_PATHS_PER_VISITOR = 50;
const MAX_CAS_ATTEMPTS = 8;

interface VisitorRecord {
  firstSeen: string;
  lastSeen: string;
  /** path -> epoch ms of the last counted view */
  paths: Record<string, number>;
}

export class ViewCounter {
  constructor(private readonly store: CounterStore) {}

  async read(): Promise<ViewCounts> {
    return (await this.store.getJSON<ViewCounts>(COUNTS_KEY))?.value ?? ZERO;
  }

  /**
   * Record a page load. Returns the totals after the write, or the current
   * totals if nothing needed counting.
   */
  async record(
    visitorId: string,
    path: string,
    now: number = Date.now(),
  ): Promise<ViewCounts> {
    const key = VISITOR_PREFIX + visitorId;
    const iso = new Date(now).toISOString();

    let existing = await this.store.getJSON<VisitorRecord>(key);
    let isNew = false;
    if (!existing) {
      // Atomic create: exactly one of any concurrent first requests wins.
      const fresh: VisitorRecord = {
        firstSeen: iso,
        lastSeen: iso,
        paths: { [path]: now },
      };
      isNew = await this.store.setJSON(key, fresh, { onlyIfNew: true });
      if (!isNew) existing = await this.store.getJSON<VisitorRecord>(key);
    }

    let countsAsView = true;
    if (existing) {
      const last = existing.value.paths[path] ?? 0;
      countsAsView = now - last >= VIEW_WINDOW_MS;
      if (countsAsView) {
        // Losing this race means a concurrent request by the same visitor
        // already wrote the record, so that one carries the view.
        countsAsView = await this.store.setJSON(
          key,
          {
            ...existing.value,
            lastSeen: iso,
            paths: prune({ ...existing.value.paths, [path]: now }),
          },
          { onlyIfMatch: existing.etag },
        );
      }
    }

    if (!isNew && !countsAsView) return this.read();
    return this.increment({
      views: countsAsView ? 1 : 0,
      unique: isNew ? 1 : 0,
    });
  }

  /** Compare-and-set increment. Retries with jittered backoff on contention. */
  private async increment(delta: ViewCounts): Promise<ViewCounts> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const current = await this.store.getJSON<ViewCounts>(COUNTS_KEY);
      const next: ViewCounts = {
        views: (current?.value.views ?? 0) + delta.views,
        unique: (current?.value.unique ?? 0) + delta.unique,
      };
      const written = await this.store.setJSON(
        COUNTS_KEY,
        next,
        current ? { onlyIfMatch: current.etag } : { onlyIfNew: true },
      );
      if (written) return next;
      await sleep(Math.random() * 20 * 2 ** attempt);
    }
    throw new Error("view counter: gave up after repeated write conflicts");
  }
}

function prune(paths: Record<string, number>): Record<string, number> {
  const entries = Object.entries(paths);
  if (entries.length <= MAX_PATHS_PER_VISITOR) return paths;
  entries.sort(([, a], [, b]) => b - a);
  return Object.fromEntries(entries.slice(0, MAX_PATHS_PER_VISITOR));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Visitor identity
// ---------------------------------------------------------------------------

let warnedAboutSalt = false;

/** Returns null in production without VIEWS_SALT: a public salt would make the hashes reversible. */
export async function hashVisitor(
  ip: string,
  userAgent: string,
  salt: string | undefined = import.meta.env.VIEWS_SALT,
): Promise<string | null> {
  if (!salt) {
    if (import.meta.env.PROD) {
      if (!warnedAboutSalt) {
        warnedAboutSalt = true;
        console.warn("VIEWS_SALT is not set; views are not being counted.");
      }
      return null;
    }
    salt = "dev";
  }
  const data = new TextEncoder().encode(`${salt}|${ip}|${userAgent}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Request filtering
// ---------------------------------------------------------------------------

const BOT_UA =
  /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|curl\/|wget\/|python|java\/|go-http|okhttp|node-fetch|axios|monitor|uptime|scan/i;

/**
 * Decide whether a request represents a real person looking at the page.
 * Rejects empty or known automated user agents, browser prefetch/prerender
 * requests, and anything without a same-origin Sec-Fetch-Site header (every
 * current browser sends it on fetch; most scripts do not).
 */
export function shouldCount(headers: Headers): boolean {
  const ua = headers.get("user-agent") ?? "";
  if (ua.length < 10 || BOT_UA.test(ua)) return false;

  const purpose = headers.get("sec-purpose") ?? headers.get("purpose") ?? "";
  if (/prefetch|prerender/i.test(purpose)) return false;

  return headers.get("sec-fetch-site") === "same-origin";
}

/** The site's routes (src/pages). Any other path rendered the 404 page. */
const ROUTES = new Set(["/", "/rover"]);

export function normalizePath(input: unknown): string {
  if (typeof input !== "string") return "/404";
  const path = input.split(/[?#]/)[0].replace(/(.)\/$/, "$1");
  return ROUTES.has(path) ? path : "/404";
}

// ---------------------------------------------------------------------------
// Store implementations
// ---------------------------------------------------------------------------

export function netlifyStore(): CounterStore | null {
  let blobs: ReturnType<typeof getStore>;
  try {
    blobs = getStore({ name: "views", consistency: "strong" });
  } catch {
    return null; // Not running on Netlify (local dev, tests).
  }
  return {
    async getJSON<T>(key: string) {
      const res = await blobs.getWithMetadata(key, { type: "json" });
      if (!res) return null;
      return { value: res.data as T, etag: res.etag ?? "" };
    },
    async setJSON(key, value, condition) {
      const res = await blobs.setJSON(key, value, condition);
      return res.modified;
    },
  };
}

export function memoryStore(): CounterStore {
  const map = new Map<string, { value: unknown; etag: string }>();
  let version = 0;
  return {
    async getJSON<T>(key: string) {
      const entry = map.get(key);
      if (!entry) return null;
      return { value: structuredClone(entry.value) as T, etag: entry.etag };
    },
    async setJSON(key, value, condition) {
      const current = map.get(key);
      if (condition && "onlyIfNew" in condition && current) return false;
      if (
        condition &&
        "onlyIfMatch" in condition &&
        current?.etag !== condition.onlyIfMatch
      )
        return false;
      map.set(key, { value: structuredClone(value), etag: String(++version) });
      return true;
    },
  };
}
