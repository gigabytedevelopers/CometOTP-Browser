import { fromBase32, u64 } from './encoding.js';
import type { Service } from './vault.js';

const HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' } as const;
const STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';

export type CodeInput = Pick<Service, 'type' | 'secret' | 'algorithm' | 'digits' | 'period'>;

/** The 31-bit value of RFC 4226's dynamic truncation, at `counter`. */
async function truncatedValue(service: CodeInput, counter: number): Promise<number> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    fromBase32(service.secret),
    { name: 'HMAC', hash: HASHES[service.algorithm] },
    false,
    ['sign'],
  );
  const hash = new DataView(await globalThis.crypto.subtle.sign('HMAC', key, u64(counter)));
  const offset = hash.getUint8(hash.byteLength - 1) & 0x0f;
  return hash.getUint32(offset) & 0x7fffffff;
}

/** The code at `time`, in Unix seconds (protocol §5). Matches CometOTP's `TokenCalculator`. */
export async function generateCode(service: CodeInput, time: number): Promise<string> {
  let value = await truncatedValue(service, Math.floor(time / service.period));
  if (service.type === 'steam') {
    let out = '';
    for (let i = 0; i < service.digits; i++) {
      out += STEAM_CHARS[value % STEAM_CHARS.length];
      value = Math.floor(value / STEAM_CHARS.length);
    }
    return out;
  }
  return String(value % 10 ** service.digits).padStart(service.digits, '0');
}

/** Seconds until the code shown at `time` changes. */
export function secondsLeft(period: number, time: number): number {
  return period - (Math.floor(time) % period);
}
