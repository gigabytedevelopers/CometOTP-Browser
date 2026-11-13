// The choices the settings offer and the rules they follow, apart from where they are kept, so
// they are tested on their own (test/choices.test.ts).
import { utf8 } from '@cometotp/protocol';

/** Minutes without input before the extension locks itself, to choose from. */
export const AUTO_LOCK_CHOICES: readonly number[] = [1, 5, 15, 30, 60, 240];
export const AUTO_LOCK_DEFAULT = 15;

/** The pairing code carries the browser's name, in at most 64 bytes (protocol §3.1). */
export const MAX_NAME_BYTES = 64;

/** "15 minutes", "1 minute", "4 hours". */
export function autoLockText(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** Why the extension last locked itself; kept until it is unlocked again. */
export interface LockReason {
  /** After the chosen time without use, when the computer locked, or with Lock now. */
  why: 'idle' | 'computer' | 'button';
  /** When, in milliseconds since the epoch. */
  at: number;
  /** For "idle", the time without use it waited, in minutes. */
  minutes?: number;
}

/**
 * What the locked popup says about why it is locked; `time` is when, already written for the
 * person. With no reason kept, the browser cleared the local key itself, as it does when it quits
 * and when the extension updates.
 */
export function lockReasonText(reason: LockReason | null, time: string): string {
  if (!reason) return 'It locked when the browser quit or CometOTP updated.';
  if (reason.why === 'computer') return `It locked at ${time}, when this computer locked.`;
  if (reason.why === 'button') return `You locked it at ${time}.`;
  const waited = reason.minutes ? ` after ${autoLockText(reason.minutes)} without use` : '';
  return `It locked at ${time}${waited}.`;
}

/**
 * What the background does when the browser says the idle state changed (src/background.ts):
 * "lock" at once; "check" how long there has been no input against the chosen time before
 * locking, as the browser may have gone by its default of a minute; "start" the chosen time over
 * while the computer is locked, as the browser reports "locked" rather than "idle" for as long as
 * it stays locked; or "stop" that, as someone is back.
 */
export function idleAction(state: 'active' | 'idle' | 'locked', lockWithComputer: boolean): 'lock' | 'check' | 'start' | 'stop' {
  if (state === 'active') return 'stop';
  if (state === 'idle') return 'check';
  return lockWithComputer ? 'lock' : 'start';
}

/** When the extension locks itself, in the popup's words. Firefox does not say when the computer locks. */
export function lockHintText(minutes: number, lockWithComputer: boolean, firefox: boolean): string {
  const withComputer = lockWithComputer && !firefox ? ', when this computer locks' : '';
  return `CometOTP locks itself after ${autoLockText(minutes)} without use${withComputer} and when the browser quits.`;
}

/** What the settings page says under the choice of time, about the other times it locks. */
export function lockAlsoText(lockWithComputer: boolean, firefox: boolean): string {
  if (firefox) return 'CometOTP also locks when the browser quits. Firefox does not tell extensions when the computer locks.';
  if (lockWithComputer) return 'CometOTP also locks when this computer locks and when the browser quits.';
  return 'CometOTP also locks when the browser quits. While this computer is locked, the time without use goes on counting.';
}

/** What is wrong with a name for this browser, if anything. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give this browser a name.';
  if (utf8(trimmed).length > MAX_NAME_BYTES) return 'That name is too long.';
  return null;
}
