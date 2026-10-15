// The pairing as the extension keeps it (protocol §8). The relay, the vault id, the read token and
// the highest version accepted stay outside the local key M, so the vault can be downloaded while
// locked; the vault key V and the phone's name are sealed under M. The vault itself is kept as
// downloaded, sealed under V (./sync.ts).
import { fromBase64UrlOfLength, fromUtf8, utf8, type Bytes } from '@cometotp/protocol';

import { openPrivate, sealPrivate, type Sealed } from '../lock/crypto.js';
import { deleteRecord, getRecord, putRecord } from '../lock/storage.js';
import { LINKS } from '../fill/links.js';
import type { Paired } from '../pair/pairing.js';
import { OFFICIAL_RELAY } from './relay.js';

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

/** Deletes everything the pairing kept: its details, the copy, and the sites filled. */
export async function forgetPairing(): Promise<void> {
  await deleteRecord(PAIRING);
  await deleteRecord(SECRET);
  await deleteRecord(BLOB);
  await deleteRecord(LINKS);
}

/** Raises the version accepted from `vault`, unless the pairing changed meanwhile. */
export async function acceptVersion(vault: string, version: number): Promise<void> {
  const record = await pairingRecord();
  if (record?.vault === vault && version > record.version) await putRecord(PAIRING, { ...record, version });
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
