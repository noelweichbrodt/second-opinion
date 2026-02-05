import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SlidingWindowRateLimiter,
  getRateLimiter,
  resetRateLimiter,
} from "./rate-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within limit", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60000,
      maxRequests: 3,
    });

    expect(limiter.canProceed()).toBe(true);
    limiter.recordRequest();
    expect(limiter.canProceed()).toBe(true);
    limiter.recordRequest();
    expect(limiter.canProceed()).toBe(true);
    limiter.recordRequest();
  });

  it("blocks requests exceeding limit", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60000,
      maxRequests: 2,
    });

    limiter.recordRequest();
    limiter.recordRequest();
    expect(limiter.canProceed()).toBe(false);
  });

  it("allows requests after window expires", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60000,
      maxRequests: 1,
    });

    limiter.recordRequest();
    expect(limiter.canProceed()).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(60001);
    expect(limiter.canProceed()).toBe(true);
  });

  it("slides window correctly (partial expiration)", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60000,
      maxRequests: 2,
    });

    // First request at t=0
    limiter.recordRequest();

    // Advance 30 seconds
    vi.advanceTimersByTime(30000);

    // Second request at t=30s
    limiter.recordRequest();

    // At limit now
    expect(limiter.canProceed()).toBe(false);

    // Advance another 30s (t=60s) - first request should expire
    vi.advanceTimersByTime(30001);

    // First request expired, second still valid
    expect(limiter.canProceed()).toBe(true);
    expect(limiter.getRemainingRequests()).toBe(1);
  });

  it("returns correct retry-after time", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60000,
      maxRequests: 1,
    });

    limiter.recordRequest();

    const retryAfter = limiter.getRetryAfterMs();
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60000);
  });

  it("returns zero retry-after when requests available", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60000,
      maxRequests: 5,
    });

    expect(limiter.getRetryAfterMs()).toBe(0);
    limiter.recordRequest();
    expect(limiter.getRetryAfterMs()).toBe(0);
  });

  it("getRemainingRequests decreases with each request", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60000,
      maxRequests: 3,
    });

    expect(limiter.getRemainingRequests()).toBe(3);
    limiter.recordRequest();
    expect(limiter.getRemainingRequests()).toBe(2);
    limiter.recordRequest();
    expect(limiter.getRemainingRequests()).toBe(1);
    limiter.recordRequest();
    expect(limiter.getRemainingRequests()).toBe(0);
  });

  it("reset clears all timestamps", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60000,
      maxRequests: 1,
    });

    limiter.recordRequest();
    expect(limiter.canProceed()).toBe(false);

    limiter.reset();
    expect(limiter.canProceed()).toBe(true);
    expect(limiter.getRemainingRequests()).toBe(1);
  });

  it("getConfig returns current configuration", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 30000,
      maxRequests: 5,
    });

    const config = limiter.getConfig();
    expect(config.windowMs).toBe(30000);
    expect(config.maxRequests).toBe(5);
  });

  it("uses default values when not specified", () => {
    const limiter = new SlidingWindowRateLimiter();
    const config = limiter.getConfig();

    expect(config.windowMs).toBe(60000);
    expect(config.maxRequests).toBe(10);
  });

  describe("checkAndRecord", () => {
    it("allows and records in one operation", () => {
      const limiter = new SlidingWindowRateLimiter({
        windowMs: 60000,
        maxRequests: 2,
      });

      const status1 = limiter.checkAndRecord();
      expect(status1.allowed).toBe(true);
      expect(status1.remaining).toBe(1);
      expect(status1.retryAfterMs).toBeNull();

      const status2 = limiter.checkAndRecord();
      expect(status2.allowed).toBe(true);
      expect(status2.remaining).toBe(0);
      expect(status2.retryAfterMs).toBeNull();

      const status3 = limiter.checkAndRecord();
      expect(status3.allowed).toBe(false);
      expect(status3.remaining).toBe(0);
      expect(status3.retryAfterMs).toBeGreaterThan(0);
    });

    it("does not record when rate limited", () => {
      const limiter = new SlidingWindowRateLimiter({
        windowMs: 60000,
        maxRequests: 1,
      });

      limiter.checkAndRecord(); // Uses the one slot
      const status = limiter.checkAndRecord(); // Should be blocked

      expect(status.allowed).toBe(false);
      // Should still have 0 remaining (not negative)
      expect(status.remaining).toBe(0);
    });
  });
});

describe("getRateLimiter singleton", () => {
  beforeEach(() => {
    resetRateLimiter();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    resetRateLimiter();
  });

  it("returns the same instance on multiple calls", () => {
    const limiter1 = getRateLimiter();
    const limiter2 = getRateLimiter();
    expect(limiter1).toBe(limiter2);
  });

  it("creates new instance after reset", () => {
    const limiter1 = getRateLimiter();
    resetRateLimiter();
    const limiter2 = getRateLimiter();
    expect(limiter1).not.toBe(limiter2);
  });

  it("reads configuration from environment variables", () => {
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "30000");
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "5");
    resetRateLimiter();

    const limiter = getRateLimiter();
    const config = limiter.getConfig();

    expect(config.windowMs).toBe(30000);
    expect(config.maxRequests).toBe(5);
  });

  it("uses defaults when env vars not set", () => {
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "");
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "");
    resetRateLimiter();

    const limiter = getRateLimiter();
    const config = limiter.getConfig();

    // Falls back to defaults when env vars are empty
    expect(config.windowMs).toBe(60000);
    expect(config.maxRequests).toBe(10);
  });
});
