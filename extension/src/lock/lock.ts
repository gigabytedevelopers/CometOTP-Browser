// The lock as the popup and the background use it: set up once, then locked or unlocked. Unlocking,
// with the password or a passkey, puts M in storage.session; locking takes it out again, so from
// then on nothing private can be opened until one of them is given again.
import { fromBase64UrlOfLength, toBase64Url, type Bytes } from '@cometotp/protocol';

import { createLock, isLockRecord, openLock, openWithPasskey, relock, wrapForPasskey, type LockRecord } from './crypto.js';
import { clearRecords, clearSessionKey, getRecord, getSessionKey, putRecord, setSessionKey } from './storage.js';

const LOCK_RECORD = 'lock';

/** No password yet; a password but no M in memory; or M in memory. */
export type LockState = 'new' | 'locked' | 'unlocked';

async function record(): Promise<LockRecord | null> {
  const value = await getRecord(LOCK_RECORD);
  return isLockRecord(value) ? value : null;
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
  await setSessionKey(toBase64Url(localKey));
}

/** Unlocks with `password`; false when it is wrong. */
export async function unlock(password: string): Promise<boolean> {
  const stored = await record();
  if (!stored) return false;
  const localKey = await openLock(stored, password);
  if (!localKey) return false;
  await setSessionKey(toBase64Url(localKey));
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
  await putRecord(LOCK_RECORD, await relock(stored, localKey, next));
  return true;
}

export function lock(): Promise<void> {
  return clearSessionKey();
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
  const stored = await record();
  const key = await localKey();
  if (!stored || !key) throw new Error('Unlock first');
  await putRecord(LOCK_RECORD, { ...stored, passkey: await wrapForPasskey(key, credential, prf) });
}

/** Unlocks with the passkey's PRF output; false when it does not open the passkey's copy. */
export async function unlockWithPasskey(prf: Bytes): Promise<boolean> {
  const wrap = (await record())?.passkey;
  if (!wrap) return false;
  const key = await openWithPasskey(wrap, prf);
  if (!key) return false;
  await setSessionKey(toBase64Url(key));
  return true;
}

/** Stops the passkey from unlocking; the password keeps working. */
export async function removePasskey(): Promise<void> {
  const stored = await record();
  if (!stored?.passkey) return;
  const { passkey: _removed, ...rest } = stored;
  await putRecord(LOCK_RECORD, rest);
}

/** Forgets the password and everything the extension keeps, for someone who has forgotten it. */
export async function reset(): Promise<void> {
  await clearSessionKey();
  await clearRecords();
}
