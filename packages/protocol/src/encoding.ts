import { ProtocolError } from './errors.js';

/** Bytes backed by a plain ArrayBuffer, which is what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Bytes {
  return encoder.encode(text);
}

/** Decodes UTF-8, refusing invalid sequences rather than replacing them. */
export function fromUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ProtocolError('bad_encoding', 'Invalid UTF-8');
  }
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u8(n: number): Bytes {
  return Uint8Array.of(n);
}

export function u16(n: number): Bytes {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n);
  return out;
}

export function u32(n: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

export function u64(n: number | bigint): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

/** `u16(len(x)) ‖ x`. */
export function lp(bytes: Uint8Array): Bytes {
  if (bytes.length > 0xffff) throw new RangeError('Too long for a 16-bit length prefix');
  return concat(u16(bytes.length), bytes);
}

/** Compares in time that depends only on the lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url (RFC 4648 §5) without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += BASE64URL[(chunk >>> (18 - 6 * j)) & 63];
  }
  return out;
}

/** Base64url without padding; refuses padding, other alphabets and impossible lengths. */
export function fromBase64Url(text: string): Bytes {
  if (text.length % 4 === 1) throw new ProtocolError('bad_encoding', 'Invalid base64url length');
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    const digit = BASE64URL.indexOf(char);
    if (digit < 0) throw new ProtocolError('bad_encoding', 'Invalid base64url character');
    value = ((value << 6) | digit) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >>> bits) & 0xff;
    }
  }
  return out;
}

/** Decodes base64url and checks the length, for keys, tokens and ids. */
export function fromBase64UrlOfLength(text: unknown, length: number, what: string): Bytes {
  if (typeof text !== 'string') throw new ProtocolError('bad_encoding', `${what} is missing`);
  const bytes = fromBase64Url(text);
  if (bytes.length !== length) throw new ProtocolError('bad_encoding', `${what} must be ${length} bytes`);
  return bytes;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648 §6), upper case, without padding. */
export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Base32, upper case, without padding; refuses other characters and impossible lengths. */
export function fromBase32(text: string): Bytes {
  if ([1, 3, 6].includes(text.length % 8)) throw new ProtocolError('bad_encoding', 'Invalid base32 length');
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) throw new ProtocolError('bad_encoding', 'Invalid base32 character');
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >>> bits) & 0xff;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(text: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) throw new ProtocolError('bad_encoding', 'Invalid hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}
