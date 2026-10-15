// Keeping the browser's copy current (protocol §7.2). The background downloads at start-up and
// every 15 minutes, and the popup on unlock and whenever it opens, each time with the version it
// has, so an unchanged vault costs one small answer.
//
// The read token is outside the local key M, so downloads work while locked. But a vault can only
// be checked with the vault key V, which is under M. So a newer version downloaded while locked is
// kept aside, still sealed, and checked on the next unlock: only then does it replace the copy.
//
// Whatever happens is kept as the status the popup shows. Codes need the right time, so the status
// also holds how far this computer's clock is from the relay's.
import { blobVersion, fromBase64UrlOfLength, type Bytes, type Payload } from '@cometotp/protocol';

import { localKey } from '../lock/lock.js';
import { deleteRecord, getRecord, putRecord } from '../lock/storage.js';
import { RelayError, deleteVault, download } from './relay.js';
import { acceptVersion, forgetPairing, pairingRecord, vaultSecret } from './store.js';
import { assess, readVault } from './vault.js';

/** Something about the copy the popup should say. */
export type SyncWarning =
  /** The relay sent an older version than the browser has accepted. */
  | 'rollback'
  /** The relay sent a vault that does not open. */
  | 'bad-vault'
  /** The phone sent a payload this extension is too old to read. */
  | 'needs-update'
  /** The relay no longer knows this browser (401 or 404): pair it again. */
  | 'repair'
  /** The relay could not be reached. */
  | 'unreachable';

export interface SyncStatus {
  /** When the relay last answered, in milliseconds since the epoch. */
  checkedAt: number | null;
  warning: SyncWarning | null;
  /** The relay's clock minus this computer's, in milliseconds, from its last answer. */
  skew: number | null;
}

interface Kept {
  version: number;
  blob: Bytes;
}

const BLOB = 'vault-blob';
const PENDING = 'vault-pending';
const STATUS = 'sync-status';
const NOTICE = 'notice';

/** Codes depend on the clock: beyond this, the popup warns (protocol §5). */
export const MAX_SKEW_MS = 30_000;

export async function syncStatus(): Promise<SyncStatus> {
  const value = (await getRecord(STATUS)) as SyncStatus | undefined;
  return value ?? { checkedAt: null, warning: null, skew: null };
}

async function setStatus(change: Partial<SyncStatus>): Promise<void> {
  await putRecord(STATUS, { ...(await syncStatus()), ...change });
}

/** "disconnected" once the phone has removed this browser, until the popup has said so. */
export async function notice(): Promise<string | null> {
  const value = await getRecord(NOTICE);
  return typeof value === 'string' ? value : null;
}

export async function clearNotice(): Promise<void> {
  await deleteRecord(NOTICE);
}

/** Downloads the vault if it changed, then checks any version kept aside if unlocked. */
export async function sync(now = Date.now()): Promise<void> {
  const record = await pairingRecord();
  if (!record) return;
  const pending = (await getRecord(PENDING)) as Kept | undefined;
  const have = Math.max(record.version, pending?.version ?? 0);
  let result;
  try {
    result = await download(record.relay, record.vault, record.read, have || undefined);
  } catch (error) {
    const repair = error instanceof RelayError && (error.status === 401 || error.status === 404);
    await setStatus({ warning: repair ? 'repair' : 'unreachable' });
    return;
  }
  const status: Partial<SyncStatus> = { checkedAt: now, warning: null, skew: result.date === null ? null : result.date - now };
  if (result.kind === 'gone') {
    // The phone removed this browser: delete everything this pairing kept, and say so.
    await forgetCopy();
    await putRecord(NOTICE, 'disconnected');
    return;
  }
  if (result.kind === 'vault') {
    let version = 0;
    try {
      version = blobVersion(result.blob);
    } catch {
      status.warning = 'bad-vault';
    }
    if (version && version < record.version) status.warning = 'rollback';
    else if (version > have) await putRecord(PENDING, { version, blob: result.blob } satisfies Kept);
  }
  await setStatus(status);
  await acceptPending();
}

/** Deletes everything the pairing kept, and what the extension knew about its downloads. */
async function forgetCopy(): Promise<void> {
  await forgetPairing();
  await deleteRecord(PENDING);
  await deleteRecord(STATUS);
}

/**
 * Disconnect (protocol §7.2): deletes the vault on the relay with the read token, so the phone
 * learns at its next upload that this browser is gone, then everything the pairing kept here, even
 * when the relay could not be reached. Says whether the relay heard it.
 */
export async function disconnect(): Promise<boolean> {
  const record = await pairingRecord();
  if (!record) return true;
  const told = await deleteVault(record.relay, record.vault, record.read).then(
    () => true,
    () => false,
  );
  await forgetCopy();
  await deleteRecord(NOTICE);
  return told;
}

/** Checks a version kept aside, if unlocked, and takes it or warns (protocol §7.2). */
export async function acceptPending(): Promise<void> {
  const pending = (await getRecord(PENDING)) as Kept | undefined;
  const key = await localKey();
  const record = await pairingRecord();
  if (!pending || !key || !record) return;
  const secret = await vaultSecret(key);
  if (!secret) return;
  const assessment = await assess(
    pending.blob,
    record.version,
    fromBase64UrlOfLength(secret.key, 32, 'The vault key'),
    fromBase64UrlOfLength(record.vault, 16, 'The vault id'),
  );
  await deleteRecord(PENDING);
  if (assessment.kind === 'accept') {
    await putRecord(BLOB, { version: assessment.version, blob: pending.blob } satisfies Kept);
    await acceptVersion(record.vault, assessment.version);
    await setStatus({ warning: null });
  } else if (assessment.kind === 'rollback') await setStatus({ warning: 'rollback' });
  else if (assessment.kind === 'bad') await setStatus({ warning: 'bad-vault' });
  else if (assessment.kind === 'newer-format') await setStatus({ warning: 'needs-update' });
}

/** The services in the copy, for the popup; null while locked or before the first download. */
export async function services(): Promise<{ payload: Payload; skipped: number } | null> {
  const key = await localKey();
  const record = await pairingRecord();
  const kept = (await getRecord(BLOB)) as Kept | undefined;
  if (!key || !record || !kept) return null;
  const secret = await vaultSecret(key);
  if (!secret) return null;
  return readVault(kept.blob, fromBase64UrlOfLength(secret.key, 32, 'The vault key'), fromBase64UrlOfLength(record.vault, 16, 'The vault id'));
}
