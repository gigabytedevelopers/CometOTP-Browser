// The extension's lock, apart from the browser (protocol §8). A random 32-byte local key M seals
// everything private the extension keeps. M itself is stored only sealed, with AES-256-GCM, under
// a key from Argon2id over the extension's password, so reading the profile on disk gives nothing
// without the password, and each guess costs 64 MiB and three passes.
import { argon2id } from 'hash-wasm/dist/index.esm.js';
import {
  concat,
  fromBase64Url,
  fromBase64UrlOfLength,
  lp,
  open,
  randomBytes,
  seal,
  toBase64Url,
  utf8,
  type Bytes,
} from '@cometotp/protocol';

/** Argon2id's settings, stored with the lock so they can be raised later without losing it. */
export interface KdfParams {
  name: 'argon2id';
  /** 16 bytes, base64url. */
  salt: string;
  /** KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

export const KDF_DEFAULTS = { memory: 64 * 1024, passes: 3, parallelism: 1 } as const;

/** AES-256-GCM output, base64url. */
export interface Sealed {
  nonce: string;
  sealed: string;
}

/** What is stored about the lock. Nothing in it opens anything without the password. */
export interface LockRecord {
  v: 1;
  kdf: KdfParams;
  /** M, sealed under the password's key. */
  password: Sealed;
}

const PASSWORD_AAD = utf8('CometOTP lock v1 password');
const PRIVATE_LABEL = utf8('CometOTP local v1');

/** The key Argon2id derives from the password, which is NFC-normalized UTF-8. */
export async function passwordKey(password: string, kdf: KdfParams): Promise<Bytes> {
  const hash = await argon2id({
    password: utf8(password.normalize('NFC')),
    salt: fromBase64UrlOfLength(kdf.salt, 16, 'The salt'),
    iterations: kdf.passes,
    parallelism: kdf.parallelism,
    memorySize: kdf.memory,
    hashLength: 32,
    outputType: 'binary',
  });
  return new Uint8Array(hash);
}

async function sealWith(key: Bytes, aad: Bytes, plaintext: Bytes): Promise<Sealed> {
  const nonce = randomBytes(12);
  return { nonce: toBase64Url(nonce), sealed: toBase64Url(await seal(key, nonce, aad, plaintext)) };
}

/** A new lock for `password`, and the local key M it holds. */
export async function createLock(password: string): Promise<{ record: LockRecord; localKey: Bytes }> {
  const localKey = randomBytes(32);
  const kdf: KdfParams = { name: 'argon2id', salt: toBase64Url(randomBytes(16)), ...KDF_DEFAULTS };
  const sealed = await sealWith(await passwordKey(password, kdf), PASSWORD_AAD, localKey);
  return { record: { v: 1, kdf, password: sealed }, localKey };
}

/** M, or null when the password is wrong (or the record was altered). */
export async function openLock(record: LockRecord, password: string): Promise<Bytes | null> {
  const key = await passwordKey(password, record.kdf);
  try {
    const localKey = await open(
      key,
      fromBase64UrlOfLength(record.password.nonce, 12, 'The nonce'),
      PASSWORD_AAD,
      fromBase64UrlOfLength(record.password.sealed, 48, 'The sealed key'),
    );
    return localKey.length === 32 ? localKey : null;
  } catch {
    return null;
  }
}

/** Whether `value` looks like a LockRecord this version can use. */
export function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, any>;
  return (
    r.v === 1 &&
    r.kdf?.name === 'argon2id' &&
    typeof r.kdf.salt === 'string' &&
    Number.isInteger(r.kdf.memory) &&
    Number.isInteger(r.kdf.passes) &&
    Number.isInteger(r.kdf.parallelism) &&
    typeof r.password?.nonce === 'string' &&
    typeof r.password?.sealed === 'string'
  );
}

/** The associated data binding a private value to its name, so values cannot be swapped. */
function privateAad(name: string): Bytes {
  return concat(PRIVATE_LABEL, lp(utf8(name)));
}

/** Seals a private value under M. */
export function sealPrivate(localKey: Bytes, name: string, value: Bytes): Promise<Sealed> {
  return sealWith(localKey, privateAad(name), value);
}

/** Opens a private value sealed under M with this name; throws if either does not match. */
export function openPrivate(localKey: Bytes, name: string, sealed: Sealed): Promise<Bytes> {
  return open(
    localKey,
    fromBase64UrlOfLength(sealed.nonce, 12, 'The nonce'),
    privateAad(name),
    fromBase64Url(sealed.sealed),
  );
}
