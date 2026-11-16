import { describe, expect, it } from "vitest";
import { checkRateLimit, resetRateLimits } from "../../app/utils/rate-limit.server";

describe("fixed-window rate limiting", () => {
  it("allows requests up to the limit", () => {
    resetRateLimits();
    const results = [0, 1, 2].map(() => checkRateLimit("shop-a", 3, 60_000, 0));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0]);
  });

  it("blocks requests beyond the limit with a retry hint", () => {
    resetRateLimits();
    checkRateLimit("shop-a", 2, 60_000, 1_000);
    checkRateLimit("shop-a", 2, 60_000, 1_000);

    const blocked = checkRateLimit("shop-a", 2, 60_000, 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("resets the counter when the window expires", () => {
    resetRateLimits();
    checkRateLimit("shop-a", 1, 60_000, 0);
    expect(checkRateLimit("shop-a", 1, 60_000, 30_000).allowed).toBe(false);
    expect(checkRateLimit("shop-a", 1, 60_000, 60_000).allowed).toBe(true);
  });

  it("keeps counters isolated per key", () => {
    resetRateLimits();
    checkRateLimit("offers:shop-a", 1, 60_000, 0);
    checkRateLimit("offers:shop-a", 1, 60_000, 0);

    expect(checkRateLimit("offers:shop-a", 1, 60_000, 0).allowed).toBe(false);
    expect(checkRateLimit("offers:shop-b", 1, 60_000, 0).allowed).toBe(true);
    expect(checkRateLimit("events:shop-a", 1, 60_000, 0).allowed).toBe(true);
  });

  it("rounds a partial retry window up to one second", () => {
    resetRateLimits();
    checkRateLimit("shop-a", 1, 1_500, 0);

    const blocked = checkRateLimit("shop-a", 1, 1_500, 1_400);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
  });
});
