import { createHmac, randomBytes } from 'node:crypto';
import { isIPv6 } from 'node:net';

const HOUR_MS = 60 * 60 * 1000;
/** Windows kept at most, about 15 MB of them. */
const MAX_WINDOWS = 100_000;

/**
 * The part of an address that one client is taken to hold: all of an IPv4 address, but only the
 * first 64 bits of an IPv6 one, since a subscriber is usually given a whole /64 and can send from
 * any address in it. IPv4 written as IPv6 (`::ffff:192.0.2.1`) counts as IPv4. Anything that is
 * not an IPv6 address is kept as it is.
 */
export function clientPrefix(address: string): string {
  const text = address.replace(/%.*$/, ''); // A zone, as in fe80::1%eth0.
  if (!isIPv6(text)) return address;
  const groups = ipv6Groups(text);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  // A dotted IPv4 ending is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string | undefined) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const [head, tail] = text.split('::');
  const front = parse(head);
  if (tail === undefined) return front;
  const back = parse(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/**
 * Fixed one-hour windows of request counts, in memory only. Client addresses are keyed by an HMAC
 * under a key made fresh at each start, so they are never kept in a form that could be read back.
 */
export class RateLimiter {
  /** In the order the windows started, oldest first. */
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly addressKey = randomBytes(32);

  constructor(private readonly maxWindows = MAX_WINDOWS) {}

  /** A key for a client address (its clientPrefix) that cannot be turned back into it. */
  addressId(address: string): string {
    return createHmac('sha256', this.addressKey).update(clientPrefix(address)).digest('base64url');
  }

  /**
   * Counts a request under [key]; returns 0 if it is allowed, otherwise the seconds until the
   * window ends (for Retry-After).
   */
  hit(key: string, limit: number, now: number): number {
    let window = this.windows.get(key);
    if (!window || now - window.start >= HOUR_MS) {
      // Added afresh to keep the order. When full, the window that started first makes room: an
      // ended one if there is any, so only a flood of keys within the hour forgets live counts.
      this.windows.delete(key);
      if (this.windows.size >= this.maxWindows) this.windows.delete(this.windows.keys().next().value!);
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
