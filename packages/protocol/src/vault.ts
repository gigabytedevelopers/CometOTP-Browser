import { hkdf, open, randomBytes, seal, sha256 } from './crypto.js';
import { concat, fromBase32, fromBase64Url, fromUtf8, toBase64Url, u32, u64, utf8, type Bytes } from './encoding.js';
import { ProtocolError } from './errors.js';

const VAULT_INFO = utf8('CometOTP vault v1');
const SERVICE_ID_LABEL = utf8('CometOTP service v1');
export const BLOB_MAGIC = utf8('COV1');
export const PAD_BLOCK = 4096;
export const MAX_BLOCKS = 255;
/** Header (12), nonce (12) and tag (16) around the padded payload. */
export const BLOB_OVERHEAD = 40;
export const MAX_BLOB_LENGTH = BLOB_OVERHEAD + MAX_BLOCKS * PAD_BLOCK;

/** `HKDF(V, vault id, VAULT_INFO, 32)`. */
export function deriveBlobKey(vaultKey: Bytes, vaultId: Bytes): Promise<Bytes> {
  return hkdf(vaultKey, vaultId, VAULT_INFO, 32);
}

/**
 * Checks a blob's shape and returns its version, without the key. This is all the relay can
 * check (protocol §6.3).
 */
export function blobVersion(blob: Bytes): number {
  const blocks = (blob.length - BLOB_OVERHEAD) / PAD_BLOCK;
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS) {
    throw new ProtocolError('bad_blob', 'A blob is 40 + 4096 × k bytes, k from 1 to 255');
  }
  if (!BLOB_MAGIC.every((byte, i) => blob[i] === byte)) throw new ProtocolError('bad_blob', 'Not a vault blob');
  const version = new DataView(blob.buffer, blob.byteOffset + 4, 8).getBigUint64(0);
  if (version < 1n || version > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtocolError('bad_blob', 'The version is out of range');
  }
  return Number(version);
}

function pad(json: Bytes): Bytes {
  const length = Math.ceil((4 + json.length) / PAD_BLOCK) * PAD_BLOCK;
  if (length > MAX_BLOCKS * PAD_BLOCK) throw new RangeError('The payload is too large for a vault');
  return concat(u32(json.length), json, new Uint8Array(length - 4 - json.length));
}

function unpad(padded: Bytes): Bytes {
  const length = new DataView(padded.buffer, padded.byteOffset, 4).getUint32(0);
  if (length > padded.length - 4) throw new ProtocolError('bad_blob', 'The payload length is out of range');
  if (padded.subarray(4 + length).some((byte) => byte !== 0)) {
    throw new ProtocolError('bad_blob', 'The padding is not zeros');
  }
  return padded.slice(4, 4 + length);
}

export interface SealVaultOptions {
  /** 12 bytes; random when left out. Only tests pass one. */
  nonce?: Bytes;
}

/** Seals a payload's JSON as vault `version` (protocol §4.2). */
export async function sealVault(
  vaultKey: Bytes,
  vaultId: Bytes,
  version: number,
  payloadJson: string,
  options: SealVaultOptions = {},
): Promise<Bytes> {
  if (!Number.isSafeInteger(version) || version < 1) throw new RangeError('The version must be a safe integer from 1');
  const header = concat(BLOB_MAGIC, u64(version));
  const nonce = options.nonce ?? randomBytes(12);
  const sealed = await seal(await deriveBlobKey(vaultKey, vaultId), nonce, concat(header, vaultId), pad(utf8(payloadJson)));
  return concat(header, nonce, sealed);
}

export interface OpenVaultOptions {
  /** The highest version accepted before; anything older is refused as a rollback. */
  minVersion?: number;
}

/** Checks and opens a downloaded blob, in the order protocol §7.2 asks for. */
export async function openVault(
  vaultKey: Bytes,
  vaultId: Bytes,
  blob: Bytes,
  options: OpenVaultOptions = {},
): Promise<{ version: number; json: string }> {
  const version = blobVersion(blob);
  if (options.minVersion !== undefined && version < options.minVersion) {
    throw new ProtocolError('rollback', `The relay served version ${version}, older than ${options.minVersion}`);
  }
  const header = blob.slice(0, 12);
  const padded = await open(
    await deriveBlobKey(vaultKey, vaultId),
    blob.slice(12, 24),
    concat(header, vaultId),
    blob.slice(24),
  );
  return { version, json: fromUtf8(unpad(padded)) };
}

export type ServiceType = 'totp' | 'steam';
export type Algorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** One shared service (protocol §4.3). */
export interface Service {
  id: string;
  type: ServiceType;
  /** Base32, upper case, without padding. */
  secret: string;
  algorithm: Algorithm;
  digits: number;
  period: number;
  issuer: string;
  label: string;
  icon?: string;
  initials?: string;
  /** `#RRGGBB`. */
  badge?: string;
  tags?: string[];
}

export interface Payload {
  v: 1;
  phone: string;
  /** Unix seconds. */
  updated: number;
  services: Service[];
}

/** `b64u(SHA256(SERVICE_ID_LABEL ‖ secret)[0:12])`. */
export async function serviceId(secret: Bytes): Promise<string> {
  return toBase64Url((await sha256(SERVICE_ID_LABEL, secret)).subarray(0, 12));
}

/** The payload's JSON, with members in the protocol's order. */
export function buildPayload(payload: Payload): string {
  return JSON.stringify({
    v: payload.v,
    phone: payload.phone,
    updated: payload.updated,
    services: payload.services.map((service) => {
      const out: Record<string, unknown> = {
        id: service.id,
        type: service.type,
        secret: service.secret,
        algorithm: service.algorithm,
        digits: service.digits,
        period: service.period,
        issuer: service.issuer,
        label: service.label,
      };
      for (const key of ['icon', 'initials', 'badge', 'tags'] as const) {
        if (service[key] !== undefined) out[key] = service[key];
      }
      return out;
    }),
  });
}

const ALGORITHMS: readonly string[] = ['SHA1', 'SHA256', 'SHA512'];

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function checkService(value: unknown): Service | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const s = value as Record<string, unknown>;
  if (s.type !== 'totp' && s.type !== 'steam') return undefined;
  if (!isString(s.id) || s.id.length !== 16 || !isString(s.secret) || !isString(s.algorithm)) return undefined;
  if (!ALGORITHMS.includes(s.algorithm) || !isString(s.issuer) || !isString(s.label)) return undefined;
  if (!Number.isInteger(s.digits) || (s.digits as number) < 4 || (s.digits as number) > 10) return undefined;
  if (!Number.isInteger(s.period) || (s.period as number) < 1) return undefined;
  try {
    if (fromBase64Url(s.id).length !== 12 || fromBase32(s.secret).length === 0) return undefined;
  } catch {
    return undefined;
  }
  const service: Service = {
    id: s.id,
    type: s.type,
    secret: s.secret,
    algorithm: s.algorithm as Algorithm,
    digits: s.digits as number,
    period: s.period as number,
    issuer: s.issuer,
    label: s.label,
  };
  if (s.icon !== undefined) {
    if (!isString(s.icon)) return undefined;
    service.icon = s.icon;
  }
  if (s.initials !== undefined) {
    if (!isString(s.initials) || [...s.initials].length < 1 || [...s.initials].length > 2) return undefined;
    service.initials = s.initials;
  }
  if (s.badge !== undefined) {
    if (!isString(s.badge) || !/^#[0-9A-Fa-f]{6}$/.test(s.badge)) return undefined;
    service.badge = s.badge;
  }
  if (s.tags !== undefined) {
    if (!Array.isArray(s.tags) || !s.tags.every(isString)) return undefined;
    service.tags = s.tags;
  }
  return service;
}

/**
 * Reads a payload. A service with an unknown type, or one that breaks the rules, is skipped and
 * counted rather than failing the whole vault; so is a second service with the same id.
 */
export function parsePayload(json: string): { payload: Payload; skipped: number } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ProtocolError('bad_payload', 'The payload is not JSON');
  }
  if (typeof value !== 'object' || value === null) throw new ProtocolError('bad_payload', 'The payload is not an object');
  const p = value as Record<string, unknown>;
  if (p.v !== 1) {
    if (Number.isInteger(p.v) && (p.v as number) > 1) {
      throw new ProtocolError('unsupported_version', 'This vault needs a newer version of the extension');
    }
    throw new ProtocolError('bad_payload', 'The payload version is missing');
  }
  if (!isString(p.phone) || utf8(p.phone).length < 1 || utf8(p.phone).length > 64) {
    throw new ProtocolError('bad_payload', "The phone's name is missing");
  }
  if (!Number.isSafeInteger(p.updated) || (p.updated as number) < 0) {
    throw new ProtocolError('bad_payload', 'The update time is missing');
  }
  if (!Array.isArray(p.services)) throw new ProtocolError('bad_payload', 'The services are missing');

  const services: Service[] = [];
  const seen = new Set<string>();
  for (const item of p.services) {
    const service = checkService(item);
    if (service && !seen.has(service.id)) {
      seen.add(service.id);
      services.push(service);
    }
  }
  return {
    payload: { v: 1, phone: p.phone, updated: p.updated as number, services },
    skipped: p.services.length - services.length,
  };
}
