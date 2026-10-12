import { concat, type Bytes } from './encoding.js';
import { ProtocolError } from './errors.js';

// Only WebCrypto, so the same code runs in the extension, in the relay and in Node's tests.
const subtle = globalThis.crypto.subtle;

export function randomBytes(length: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)));
}

/** HKDF with SHA-256 (RFC 5869). */
export async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

async function aesKey(key: Bytes, usage: KeyUsage): Promise<CryptoKey> {
  if (key.length !== 32) throw new RangeError('AES-256 needs a 32-byte key');
  return subtle.importKey('raw', key, 'AES-GCM', false, [usage]);
}

/** AES-256-GCM: the ciphertext followed by the 16-byte tag. */
export async function seal(key: Bytes, nonce: Bytes, aad: Bytes, plaintext: Bytes): Promise<Bytes> {
  if (nonce.length !== 12) throw new RangeError('AES-GCM needs a 12-byte nonce');
  const params = { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 };
  return new Uint8Array(await subtle.encrypt(params, await aesKey(key, 'encrypt'), plaintext));
}

/** Opens what {@link seal} made; any change to the key, nonce, data or ciphertext fails. */
export async function open(key: Bytes, nonce: Bytes, aad: Bytes, sealed: Bytes): Promise<Bytes> {
  if (nonce.length !== 12) throw new RangeError('AES-GCM needs a 12-byte nonce');
  const params = { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 };
  const cryptoKey = await aesKey(key, 'decrypt');
  try {
    return new Uint8Array(await subtle.decrypt(params, cryptoKey, sealed));
  } catch {
    throw new ProtocolError('auth_failed', 'Could not open: wrong key, or the data was changed');
  }
}

// P-256 (SEC 2, secp256r1): y² = x³ − 3x + b over the field of P.
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

function toBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n;
}

/** Whether `raw` is an uncompressed P-256 point (0x04 ‖ X ‖ Y) on the curve. */
export function isP256Point(raw: Uint8Array): boolean {
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  const x = toBigInt(raw.subarray(1, 33));
  const y = toBigInt(raw.subarray(33, 65));
  if (x >= P || y >= P) return false;
  return (y * y) % P === (((x * x) % P) * x - 3n * x + B + 3n * P) % P;
}

/**
 * Imports a peer's public key. The point is checked here as well as by WebCrypto, because the
 * protocol requires it and not every implementation is known to.
 */
export async function importPublicKey(raw: Bytes): Promise<CryptoKey> {
  if (!isP256Point(raw)) throw new ProtocolError('bad_public_key', 'Not a P-256 public key');
  try {
    return await subtle.importKey('raw', raw, ECDH_P256, true, []);
  } catch {
    throw new ProtocolError('bad_public_key', 'Not a P-256 public key');
  }
}

export interface KeyPair {
  /** Not extractable: it can be used, never read. */
  privateKey: CryptoKey;
  /** Uncompressed SEC1, 65 bytes. */
  publicKey: Bytes;
}

/** A new ephemeral P-256 key pair. */
export async function generateKeyPair(): Promise<KeyPair> {
  const pair = await subtle.generateKey(ECDH_P256, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

/** P-256 Diffie–Hellman: the shared x-coordinate, exactly 32 bytes. */
export async function ecdh(privateKey: CryptoKey, peerPublicKey: Bytes): Promise<Bytes> {
  const peer = await importPublicKey(peerPublicKey);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
}
