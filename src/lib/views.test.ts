import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VIEW_WINDOW_MS,
  ViewCounter,
  hashVisitor,
  memoryStore,
  normalizePath,
  shouldCount,
  type CounterStore,
} from "./views";

const T0 = 1_700_000_000_000;

describe("ViewCounter", () => {
  it("starts at zero", async () => {
    const counter = new ViewCounter(memoryStore());
    expect(await counter.read()).toEqual({ views: 0, unique: 0 });
  });

  it("counts a first visit as one view and one unique viewer", async () => {
    const counter = new ViewCounter(memoryStore());
    expect(await counter.record("a", "/", T0)).toEqual({ views: 1, unique: 1 });
  });

  it("ignores a repeat load of the same page inside the window", async () => {
    const counter = new ViewCounter(memoryStore());
    await counter.record("a", "/", T0);
    const after = await counter.record("a", "/", T0 + VIEW_WINDOW_MS - 1);
    expect(after).toEqual({ views: 1, unique: 1 });
  });

  it("counts the same page again once the window has passed", async () => {
    const counter = new ViewCounter(memoryStore());
    await counter.record("a", "/", T0);
    const after = await counter.record("a", "/", T0 + VIEW_WINDOW_MS);
    expect(after).toEqual({ views: 2, unique: 1 });
  });

  it("counts a different page by the same visitor as a new view only", async () => {
    const counter = new ViewCounter(memoryStore());
    await counter.record("a", "/", T0);
    expect(await counter.record("a", "/rover", T0 + 1)).toEqual({
      views: 2,
      unique: 1,
    });
  });

  it("counts distinct visitors separately", async () => {
    const counter = new ViewCounter(memoryStore());
    await counter.record("a", "/", T0);
    await counter.record("b", "/", T0);
    expect(await counter.read()).toEqual({ views: 2, unique: 2 });
  });

  it("does not lose updates under concurrent writes", async () => {
    const counter = new ViewCounter(memoryStore());
    const visitors = Array.from({ length: 25 }, (_, i) => `v${i}`);
    await Promise.all(visitors.map((v) => counter.record(v, "/", T0)));
    expect(await counter.read()).toEqual({ views: 25, unique: 25 });
  });

  it("counts a concurrent first visit by one visitor exactly once", async () => {
    const counter = new ViewCounter(memoryStore());
    await Promise.all(
      Array.from({ length: 10 }, () => counter.record("a", "/", T0)),
    );
    expect(await counter.read()).toEqual({ views: 1, unique: 1 });
  });

  it("gives up after repeated compare-and-set failures", async () => {
    const inner = memoryStore();
    const alwaysStale: CounterStore = {
      getJSON: (k) => inner.getJSON(k),
      setJSON: (k, v, c) =>
        c && "onlyIfMatch" in c
          ? Promise.resolve(false)
          : inner.setJSON(k, v, c),
    };
    const counter = new ViewCounter(alwaysStale);
    await counter.record("a", "/", T0); // first write uses onlyIfNew, succeeds
    await expect(counter.record("b", "/", T0)).rejects.toThrow(/conflicts/);
  });

  it("counts a view once when the visitor record changes mid-write", async () => {
    const inner = memoryStore();
    const counter = new ViewCounter(inner);
    await counter.record("a", "/", T0);
    // Another request updates the record between this one's read and write.
    const racing: CounterStore = {
      async getJSON<T>(k: string) {
        const got = await inner.getJSON<T>(k);
        if (k.startsWith("visitor/")) await inner.setJSON(k, got!.value);
        return got;
      },
      setJSON: (k, v, c) => inner.setJSON(k, v, c),
    };
    const after = await new ViewCounter(racing).record(
      "a",
      "/",
      T0 + VIEW_WINDOW_MS,
    );
    expect(after).toEqual({ views: 1, unique: 1 });
  });
});

describe("hashVisitor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is stable for the same inputs and salt", async () => {
    const a = await hashVisitor("1.2.3.4", "Mozilla/5.0", "s");
    const b = await hashVisitor("1.2.3.4", "Mozilla/5.0", "s");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the salt", async () => {
    const a = await hashVisitor("1.2.3.4", "Mozilla/5.0", "s1");
    const b = await hashVisitor("1.2.3.4", "Mozilla/5.0", "s2");
    expect(a).not.toBe(b);
  });

  it("refuses to hash without a salt in production", async () => {
    vi.stubEnv("PROD", true);
    expect(await hashVisitor("1.2.3.4", "Mozilla/5.0", "")).toBeNull();
  });
});

describe("shouldCount", () => {
  const browser =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  const h = (init: Record<string, string>) => new Headers(init);

  it("accepts a normal same-origin browser fetch", () => {
    expect(
      shouldCount(
        h({ "user-agent": browser, "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(true);
  });

  it("rejects missing or automated user agents", () => {
    expect(shouldCount(h({}))).toBe(false);
    expect(shouldCount(h({ "user-agent": "curl/8.4.0" }))).toBe(false);
    expect(shouldCount(h({ "user-agent": "Googlebot/2.1" }))).toBe(false);
    expect(shouldCount(h({ "user-agent": "python-requests/2.31" }))).toBe(
      false,
    );
  });

  it("rejects prefetch, cross-site and fetch-metadata-less requests", () => {
    expect(
      shouldCount(h({ "user-agent": browser, "sec-purpose": "prefetch" })),
    ).toBe(false);
    expect(
      shouldCount(h({ "user-agent": browser, "sec-fetch-site": "cross-site" })),
    ).toBe(false);
    expect(shouldCount(h({ "user-agent": browser }))).toBe(false);
  });
});

describe("normalizePath", () => {
  it("keeps site routes and strips query, hash and trailing slash", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/rover/?x=1#y")).toBe("/rover");
  });

  it("files anything else under the 404 page", () => {
    expect(normalizePath(undefined)).toBe("/404");
    expect(normalizePath("rover")).toBe("/404");
    expect(normalizePath("//evil.example")).toBe("/404");
    expect(normalizePath("/" + "a".repeat(300))).toBe("/404");
  });
});
