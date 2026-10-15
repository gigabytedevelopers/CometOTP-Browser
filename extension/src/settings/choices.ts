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

/** What is wrong with a name for this browser, if anything. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give this browser a name.';
  if (utf8(trimmed).length > MAX_NAME_BYTES) return 'That name is too long.';
  return null;
}
