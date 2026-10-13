import { createHmac, randomBytes } from 'node:crypto';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Fixed one-hour windows of request counts, in memory only. Client addresses are keyed by an HMAC
 * under a key made fresh at each start, so they are never kept in a form that could be read back.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly addressKey = randomBytes(32);

  /** A key for a client address that cannot be turned back into it. */
  addressId(address: string): string {
    return createHmac('sha256', this.addressKey).update(address).digest('base64url');
  }

  /**
   * Counts a request under [key]; returns 0 if it is allowed, otherwise the seconds until the
   * window ends (for Retry-After).
   */
  hit(key: string, limit: number, now: number): number {
    let window = this.windows.get(key);
    if (!window || now - window.start >= HOUR_MS) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= limit) return Math.max(1, Math.ceil((window.start + HOUR_MS - now) / 1000));
    window.count++;
    return 0;
  }

  /** Forgets windows that have ended. */
  prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= HOUR_MS) this.windows.delete(key);
    }
  }
}
