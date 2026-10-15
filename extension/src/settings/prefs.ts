// The extension's settings that are not secret: how soon it locks itself, and the name it gives
// the phone when pairing. They are kept outside the local key, as the background needs the first
// while locked, and the name is the phone's to see anyway.
import { deleteRecord, getRecord, putRecord } from '../lock/storage.js';
import { thisBrowser } from '../pair/browser-name.js';
import { AUTO_LOCK_CHOICES, AUTO_LOCK_DEFAULT, nameProblem } from './choices.js';

const AUTO_LOCK = 'auto-lock';
const NAME = 'browser-name';

export async function autoLockMinutes(): Promise<number> {
  const value = await getRecord(AUTO_LOCK);
  return typeof value === 'number' && AUTO_LOCK_CHOICES.includes(value) ? value : AUTO_LOCK_DEFAULT;
}

export async function setAutoLockMinutes(minutes: number): Promise<void> {
  if (!AUTO_LOCK_CHOICES.includes(minutes)) throw new RangeError(`Not a choice: ${minutes} minutes`);
  if (minutes === AUTO_LOCK_DEFAULT) await deleteRecord(AUTO_LOCK);
  else await putRecord(AUTO_LOCK, minutes);
}

/** The name the phone is given when pairing: the person's, or one such as "Chrome on macOS". */
export async function pairingName(): Promise<string> {
  const value = await getRecord(NAME);
  return typeof value === 'string' && !nameProblem(value) ? value : thisBrowser();
}

/** Keeps the name for the next pairing; the browser's own when null or the same. */
export async function setPairingName(name: string | null): Promise<void> {
  const trimmed = name?.trim() ?? '';
  if (!trimmed || trimmed === thisBrowser()) {
    await deleteRecord(NAME);
    return;
  }
  const problem = nameProblem(trimmed);
  if (problem) throw new Error(problem);
  await putRecord(NAME, trimmed);
}
