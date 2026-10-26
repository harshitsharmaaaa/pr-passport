import { beforeEach, describe, expect, it } from "bun:test";
import { rateLimit, resetRateLimits } from "./rate-limit";

beforeEach(() => {
  resetRateLimits();
});

describe("rateLimit", () => {
  it("allows requests up to the limit and then blocks", () => {
    const options = { windowMs: 1_000, max: 2 };
    expect(rateLimit("a", options, 1_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(rateLimit("a", options, 1_100)).toMatchObject({ allowed: true, remaining: 0 });
    expect(rateLimit("a", options, 1_200)).toMatchObject({ allowed: false, remaining: 0 });
    expect(rateLimit("a", options, 1_200).retryAfterSeconds).toBe(1);
  });

  it("resets after the window", () => {
    const options = { windowMs: 1_000, max: 1 };
    expect(rateLimit("a", options, 1_000).allowed).toBe(true);
    expect(rateLimit("a", options, 1_500).allowed).toBe(false);
    expect(rateLimit("a", options, 2_001).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const options = { windowMs: 1_000, max: 1 };
    expect(rateLimit("one", options, 1_000).allowed).toBe(true);
    expect(rateLimit("two", options, 1_000).allowed).toBe(true);
    expect(rateLimit("one", options, 1_000).allowed).toBe(false);
  });

  it("reports a minimum retry delay of one second", () => {
    const options = { windowMs: 2_000, max: 1 };
    rateLimit("a", options, 1_000);
    const blocked = rateLimit("a", options, 1_990);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});