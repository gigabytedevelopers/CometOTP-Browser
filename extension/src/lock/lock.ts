// The lock as the popup and the background use it: set up once, then locked or unlocked. Unlocking,
// with the password or a passkey, puts M in storage.session; locking takes it out again, so from
// then on nothing private can be opened until one of them is given again. Locking also keeps why
// and when, outside M, so the locked popup can say; unlocking forgets it.
import { fromBase64UrlOfLength, toBase64Url, type Bytes } from '@cometotp/protocol';

import { deleteVault } from '../sync/relay.js';
import type { LockReason } from '../settings/choices.js';
import { pairingRecord } from '../sync/store.js';
import { createLock, isLockRecord, openLock, openWithPasskey, relock, wrapForPasskey, type LockRecord } from './crypto.js';
import {
  clearRecords,
  clearSessionKey,
  deleteRecord,
  getRecord,
  getSessionKey,
  onSessionKeyChange,
  putRecord,
  setSessionKey,
  updateRecords,
} from './storage.js';

const LOCK_RECORD = 'lock';
const LOCK_REASON = 'lock-reason';

/** How long a reset waits for the relay to delete the vault. */
const RESET_DELETE_MS = 5000;

/** No password yet; a password but no M in memory; or M in memory. */
export type LockState = 'new' | 'locked' | 'unlocked';

async function record(): Promise<LockRecord | null> {
  const value = await getRecord(LOCK_RECORD);
  return isLockRecord(value) ? value : null;
}

/**
 * Changes the lock record as it is when written, not as it was read before some slow work, so a
 * passkey removed during a password change stays removed. `change` returns null to leave it.
 * Says whether it was changed.
 */
async function updateLock(change: (current: LockRecord) => LockRecord | null): Promise<boolean> {
  let changed = false;
  await updateRecords([LOCK_RECORD], (records) => {
    const current = records[LOCK_RECORD];
    const next = isLockRecord(current) ? change(current) : null;
    changed = next !== null;
    return next ? { [LOCK_RECORD]: next } : {};
  });
  return changed;
}

export async function state(): Promise<LockState> {
  if (!(await record())) return 'new';
  return (await getSessionKey()) ? 'unlocked' : 'locked';
}

/** Sets the password and unlocks. Refuses when there is one already: that takes a reset. */
export async function setUp(password: string): Promise<void> {
  if (await record()) throw new Error('A password is set already');
  const { record: created, localKey } = await createLock(password);
  await putRecord(LOCK_RECORD, created);
  await unlockWith(localKey);
}

/** Unlocks with `password`; false when it is wrong. */
export async function unlock(password: string): Promise<boolean> {
  const stored = await record();
  if (!stored) return false;
  const localKey = await openLock(stored, password);
  if (!localKey) return false;
  await unlockWith(localKey);
  return true;
}

/**
 * Replaces the password, given the current one; false when that is wrong. Works locked or
 * unlocked, and leaves it as it was: M stays the same, so does everything sealed under it.
 */
export async function changePassword(current: string, next: string): Promise<boolean> {
  const stored = await record();
  if (!stored) return false;
  const localKey = await openLock(stored, current);
  if (!localKey) return false;
  const { kdf, password } = await relock(stored, localKey, next);
  // Only the password's part is replaced, and only if no other change or reset replaced it
  // meanwhile: a reset would have made another M.
  return updateLock((now) => (now.password.sealed === stored.password.sealed ? { ...now, kdf, password } : null));
}

/** Puts M in storage.session, forgetting why the extension last locked. */
async function unlockWith(localKey: Bytes): Promise<void> {
  await deleteRecord(LOCK_REASON);
  await setSessionKey(toBase64Url(localKey));
}

/**
 * Locks, keeping why: with Lock now unless said otherwise, and for "idle" after how many minutes.
 * Only a lock that ends an unlocked time is kept, so a later one does not hide why it locked.
 */
export async function lock(why: LockReason['why'] = 'button', minutes?: number): Promise<void> {
  if (await getSessionKey()) {
    const reason: LockReason = { why, at: Date.now(), ...(minutes ? { minutes } : {}) };
    await putRecord(LOCK_REASON, reason);
  }
  await clearSessionKey();
}

/** Why the extension last locked itself, or null when the browser cleared M itself or it is unlocked. */
export async function lockReason(): Promise<LockReason | null> {
  const value = (await getRecord(LOCK_REASON)) as Partial<LockReason> | undefined;
  const whys: readonly unknown[] = ['idle', 'computer', 'button'];
  if (!value || !whys.includes(value.why) || typeof value.at !== 'number') return null;
  if ((await getSessionKey()) !== null) return null;
  return { why: value.why as LockReason['why'], at: value.at, ...(typeof value.minutes === 'number' ? { minutes: value.minutes } : {}) };
}

/**
 * Calls `listener` each time the extension locks or unlocks, wherever that happened: the
 * background locks after a time without use, and any page may lock, unlock or reset.
 */
export function onLockChange(listener: (unlocked: boolean) => void): void {
  onSessionKeyChange(listener);
}

/** M while unlocked; null while locked. */
export async function localKey(): Promise<Bytes | null> {
  const value = await getSessionKey();
  return value ? fromBase64UrlOfLength(value, 32, 'The local key') : null;
}

/** The credential id of the passkey that can unlock, or null when there is none. */
export async function passkeyCredential(): Promise<string | null> {
  return (await record())?.passkey?.credential ?? null;
}

/**
 * Lets the passkey with `credential` unlock, from its PRF output. Needs the extension unlocked, as
 * it seals M; replaces any passkey added before.
 */
export async function addPasskey(credential: string, prf: Bytes): Promise<void> {
  const key = await localKey();
  if (!key) throw new Error('Unlock first');
  const passkey = await wrapForPasskey(key, credential, prf);
  if (!(await updateLock((now) => ({ ...now, passkey })))) throw new Error('Unlock first');
}

/** Unlocks with the passkey's PRF output; false when it does not open the passkey's copy. */
export async function unlockWithPasskey(prf: Bytes): Promise<boolean> {
  const wrap = (await record())?.passkey;
  if (!wrap) return false;
  const key = await openWithPasskey(wrap, prf);
  if (!key) return false;
  await unlockWith(key);
  return true;
}

/** Stops the passkey from unlocking; the password keeps working. */
export async function removePasskey(): Promise<void> {
  await updateLock(({ passkey, ...rest }) => (passkey ? rest : null));
}

/**
 * Forgets the password and everything the extension keeps, for someone who has forgotten it. First
 * it deletes the vault on the relay, as Disconnect does, with the read token, which is outside M:
 * the phone then learns at its next upload that this browser is gone. That is best effort, and
 * waits a few seconds at most.
 */
export async function reset(): Promise<void> {
  const pairing = await pairingRecord();
  if (pairing) {
    await deleteVault(pairing.relay, pairing.vault, pairing.read, AbortSignal.timeout(RESET_DELETE_MS)).catch(() => undefined);
  }
  await clearSessionKey();
  await clearRecords();
}
