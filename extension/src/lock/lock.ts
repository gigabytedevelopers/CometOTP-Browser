// The lock as the popup and the background use it: set up once, then locked or unlocked. Unlocking
// puts M in storage.session; locking takes it out again, so from then on nothing private can be
// opened until the password is given again.
import { fromBase64UrlOfLength, toBase64Url, type Bytes } from '@cometotp/protocol';

import { createLock, isLockRecord, openLock, type LockRecord } from './crypto.js';
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

export function lock(): Promise<void> {
  return clearSessionKey();
}

/** M while unlocked; null while locked. */
export async function localKey(): Promise<Bytes | null> {
  const value = await getSessionKey();
  return value ? fromBase64UrlOfLength(value, 32, 'The local key') : null;
}

/** Forgets the password and everything the extension keeps, for someone who has forgotten it. */
export async function reset(): Promise<void> {
  await clearSessionKey();
  await clearRecords();
}
