// A rough estimate of how hard a password is to guess, for the setup screen's meter. It counts
// what an attacker would try first: common passwords, a common word with digits or symbols around
// it, repeats and runs such as "aaaa" or "1234" or "qwerty", and otherwise the length and the
// kinds of characters. It is a guide, not a guarantee, and errs on the cautious side.

/** At least this many characters, whatever the meter says. */
export const MIN_LENGTH = 10;

export type Score = 0 | 1 | 2 | 3 | 4;

/** The weakest score setup accepts. */
export const MIN_SCORE: Score = 2;

export const SCORE_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

// Some of the most used passwords and words in them; a few of their variants get caught below.
const COMMON = new Set([
  'password', 'passw0rd', 'p@ssw0rd', 'letmein', 'welcome', 'qwerty', 'qwertyuiop', 'asdfgh',
  'zxcvbn', 'iloveyou', 'admin', 'administrator', 'login', 'master', 'monkey', 'dragon', 'football',
  'baseball', 'sunshine', 'princess', 'shadow', 'superman', 'batman', 'trustno1', 'whatever',
  'secret', 'changeme', 'default', 'abc123', '123456', '1234567890', 'cometotp', 'comet', 'otp',
  'google', 'facebook', 'microsoft', 'apple', 'samsung', 'chrome', 'firefox', 'browser',
]);

const ROWS = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function charsetSize(password: string): number {
  let size = 0;
  if (/[a-z]/.test(password)) size += 26;
  if (/[A-Z]/.test(password)) size += 26;
  if (/[0-9]/.test(password)) size += 10;
  if (/[ -/:-@[-`{-~]/.test(password)) size += 33;
  if (/[^\x00-\x7f]/.test(password)) size += 100;
  return Math.max(size, 1);
}

/** Whether `b` follows `a` on the alphabet, the digits or a keyboard row, either way. */
function inRun(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return ROWS.some((row) => {
    const i = row.indexOf(x);
    return i >= 0 && (row[i + 1] === y || row[i - 1] === y);
  });
}

/** The characters that add to the guessing work: repeats and runs count once. */
function effectiveLength(password: string): number {
  const chars = [...password];
  let length = chars.length ? 1 : 0;
  for (let i = 1; i < chars.length; i++) {
    const repeated = chars[i] === chars[i - 1];
    const run = inRun(chars[i - 1]!, chars[i]!) && i >= 2 && inRun(chars[i - 2]!, chars[i - 1]!);
    if (!repeated && !run) length++;
  }
  return length;
}

/** Bits of guessing work, roughly. */
export function estimateBits(password: string): number {
  const lower = password.toLowerCase();
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, '').replace(/[@4]/g, 'a').replace(/0/g, 'o').replace(/[1!]/g, 'i').replace(/3/g, 'e').replace(/[5$]/g, 's');
  if (COMMON.has(lower) || COMMON.has(core)) return Math.min(10, password.length);
  return effectiveLength(password) * Math.log2(charsetSize(password));
}

export function score(password: string): Score {
  const bits = estimateBits(password);
  if (bits < 28) return 0;
  if (bits < 40) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

/** Why `password` cannot be the extension's password, or null when it can. */
export function problem(password: string): string | null {
  if ([...password].length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (score(password) < MIN_SCORE) return 'That would be easy to guess. Try a few unrelated words.';
  return null;
}
