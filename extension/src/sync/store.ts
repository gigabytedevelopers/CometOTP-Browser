// The pairing as the extension keeps it (protocol §8). The relay, the vault id, the read token and
// the highest version accepted stay outside the local key M, so the vault can be downloaded while
// locked; the vault key V and the phone's name are sealed under M. The vault itself is kept as
// downloaded, sealed under V.
import { fromBase64UrlOfLength, fromUtf8, openVault, parsePayload, utf8, type Bytes } from '@cometotp/protocol';

import { openPrivate, sealPrivate, type Sealed } from '../lock/crypto.js';
import { deleteRecord, getRecord, putRecord } from '../lock/storage.js';
import type { Paired } from '../pair/pairing.js';
import { OFFICIAL_RELAY, download } from './relay.js';

export interface PairingRecord {
  v: 1;
  relay: string;
  /** The vault id, base64url. */
  vault: string;
  /** The read token, base64url. */
  read: string;
  /** The highest vault version accepted; 0 before the first download. */
  version: number;
  pairedAt: number;
}

interface VaultSecret {
  /** The vault key V, base64url. */
  key: string;
  phone: string;
}

const PAIRING = 'pairing';
const SECRET = 'vault-secret';
const BLOB = 'vault-blob';
const RELAY = 'relay';

function isPairingRecord(value: unknown): value is PairingRecord {
  const r = value as Record<string, unknown> | null;
  return (
    r?.v === 1 &&
    typeof r.relay === 'string' &&
    typeof r.vault === 'string' &&
    typeof r.read === 'string' &&
    Number.isSafeInteger(r.version) &&
    typeof r.pairedAt === 'number'
  );
}

export async function pairingRecord(): Promise<PairingRecord | null> {
  const value = await getRecord(PAIRING);
  return isPairingRecord(value) ? value : null;
}

/** Keeps what the phone sent, checking its lengths; the vault key and phone name under M. */
export async function storePairing(paired: Paired, localKey: Bytes, now = Date.now()): Promise<void> {
  fromBase64UrlOfLength(paired.vault.id, 16, 'The vault id');
  fromBase64UrlOfLength(paired.vault.read, 32, 'The read token');
  fromBase64UrlOfLength(paired.vault.key, 32, 'The vault key');
  const secret: VaultSecret = { key: paired.vault.key, phone: paired.phone };
  await putRecord(SECRET, await sealPrivate(localKey, SECRET, utf8(JSON.stringify(secret))));
  const record: PairingRecord = { v: 1, relay: paired.relay, vault: paired.vault.id, read: paired.vault.read, version: 0, pairedAt: now };
  await putRecord(PAIRING, record);
}

/** The vault key and phone name, which need M. */
export async function vaultSecret(localKey: Bytes): Promise<VaultSecret | null> {
  const sealed = (await getRecord(SECRET)) as Sealed | undefined;
  if (!sealed) return null;
  return JSON.parse(fromUtf8(await openPrivate(localKey, SECRET, sealed))) as VaultSecret;
}

export async function forgetPairing(): Promise<void> {
  await deleteRecord(PAIRING);
  await deleteRecord(SECRET);
  await deleteRecord(BLOB);
}

/**
 * Downloads the vault and checks that it opens with V, keeping it as downloaded and raising the
 * version accepted. Returns how many services it holds, or null when the phone has not uploaded
 * one yet or the vault is gone.
 */
export async function downloadVault(localKey: Bytes): Promise<number | null> {
  const record = await pairingRecord();
  const secret = await vaultSecret(localKey);
  if (!record || !secret) return null;
  const result = await download(record.relay, record.vault, record.read);
  if (result.kind !== 'vault') return null;
  const id = fromBase64UrlOfLength(record.vault, 16, 'The vault id');
  const key = fromBase64UrlOfLength(secret.key, 32, 'The vault key');
  const { version, json } = await openVault(key, id, result.blob, record.version ? { minVersion: record.version } : {});
  const { payload } = parsePayload(json);
  await putRecord(BLOB, { version, etag: result.etag, blob: result.blob });
  await putRecord(PAIRING, { ...record, version });
  return payload.services.length;
}

/** The relay to pair through: the person's own, or the official one. */
export async function chosenRelay(): Promise<string> {
  const value = await getRecord(RELAY);
  return typeof value === 'string' ? value : OFFICIAL_RELAY;
}

/** Keeps `relay` for the next pairing; the official one when null. */
export async function chooseRelay(relay: string | null): Promise<void> {
  if (relay === null || relay === OFFICIAL_RELAY) await deleteRecord(RELAY);
  else await putRecord(RELAY, relay);
}
