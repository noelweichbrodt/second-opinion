/**
 * Sliding window rate limiter for API request throttling.
 * Prevents abuse by limiting requests within a time window.
 */

export interface RateLimiterConfig {
  /** Time window in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
  /** Maximum requests allowed per window (default: 10) */
  maxRequests: number;
}

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number | null;
}

/**
 * In-memory sliding window rate limiter.
 * Tracks request timestamps and enforces limits within a rolling window.
 */
export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private windowMs: number;
  private maxRequests: number;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.windowMs = config.windowMs ?? 60000;
    this.maxRequests = config.maxRequests ?? 10;
  }

  /**
   * Check if a request can proceed without recording it.
   */
  canProceed(): boolean {
    this.pruneOldTimestamps();
    return this.timestamps.length < this.maxRequests;
  }

  /**
   * Record a request. Should be called after canProceed() returns true.
   */
  recordRequest(): void {
    this.timestamps.push(Date.now());
  }

  /**
   * Check and record in one atomic operation.
   * Returns status including whether the request was allowed.
   */
  checkAndRecord(): RateLimitStatus {
    this.pruneOldTimestamps();

    const remaining = Math.max(0, this.maxRequests - this.timestamps.length);
    const allowed = remaining > 0;

    if (allowed) {
      this.timestamps.push(Date.now());
    }

    return {
      allowed,
      remaining: allowed ? remaining - 1 : 0,
      retryAfterMs: allowed ? null : this.getRetryAfterMs(),
    };
  }

  /**
   * Get the number of remaining requests in the current window.
   */
  getRemainingRequests(): number {
    this.pruneOldTimestamps();
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }

  /**
   * Get the time in milliseconds until the next request slot opens.
   * Returns 0 if requests are available.
   */
  getRetryAfterMs(): number {
    this.pruneOldTimestamps();

    if (this.timestamps.length < this.maxRequests) {
      return 0;
    }

    // Find the oldest timestamp that's still in the window
    const oldestInWindow = this.timestamps[0];
    if (!oldestInWindow) {
      return 0;
    }

    const now = Date.now();
    const expiresAt = oldestInWindow + this.windowMs;
    return Math.max(0, expiresAt - now);
  }

  /**
   * Reset the rate limiter (useful for testing).
   */
  reset(): void {
    this.timestamps = [];
  }

  /**
   * Get current configuration.
   */
  getConfig(): RateLimiterConfig {
    return {
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
    };
  }

  /**
   * Remove timestamps outside the current window.
   */
  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }
}

// Default singleton instance configured from environment
let defaultInstance: SlidingWindowRateLimiter | null = null;

/**
 * Get the default rate limiter instance.
 * Configured from RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS env vars.
 */
export function getRateLimiter(): SlidingWindowRateLimiter {
  if (!defaultInstance) {
    defaultInstance = new SlidingWindowRateLimiter({
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "10", 10),
    });
  }
  return defaultInstance;
}

/**
 * Reset the default rate limiter instance.
 * Primarily used for testing.
 */
export function resetRateLimiter(): void {
  defaultInstance = null;
}
