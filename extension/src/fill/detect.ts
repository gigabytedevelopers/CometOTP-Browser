// Which inputs take a one-time code (design §4, Filling). The content script describes each input
// as a FieldInfo and asks here; nothing in this file touches a page, so the rules are tested on
// their own (test/detect.test.ts). They err towards no button: a missing one costs a copy and
// paste, a wrong one offers codes where they do not belong.

/** What the content script reads from an input. */
export interface FieldInfo {
  /** The input's type, lowercased: "text" when the attribute is absent. */
  type: string;
  /** The autocomplete attribute, lowercased. */
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  /** Its aria-label, title, and the text of its labels and of what aria-labelledby names. */
  label: string;
  /** The maxlength attribute, or -1 when there is none. */
  maxLength: number;
  inputMode: string;
  pattern: string;
}

/** Types a code can be typed into. Some sites hide codes as they are typed, as passwords. */
const TYPES = new Set(['text', 'tel', 'number', 'password']);

/** Autocomplete tokens for something else: a field that says what it is, and is not a code. */
const OTHER_AUTOCOMPLETE =
  /^(?:username|email|current-password|new-password|name|given-name|family-name|organization|street-address|address-.+|postal-code|country(?:-name)?|tel(?:-.+)?|cc-.+|bday(?:-.+)?|transaction-.+)$/;

/** Words that make a field a code field on their own. */
const CODE_WORDS = new Set(['otp', 'totp', 'hotp', 'mfa', '2fa', 'tfa', 'otc', 'passcode', 'twofactor', 'onetime']);

/** Words that start a word that makes a code field: "otpCode", "mfaToken". */
const CODE_PREFIXES = ['otp', 'totp', 'mfa', '2fa'];

/** Phrases that do the same, matched on whole words. */
const CODE_PHRASES = [
  'one time',
  'two factor',
  'two step',
  '2 step',
  'verification code',
  'verify code',
  'auth code',
  'authentication code',
  'authenticator code',
  'security code',
  'login code',
  'sign in code',
  'app code',
  '6 digit',
  'six digit',
];

/**
 * Words for codes this extension does not have: sent by text or email, printed as recovery
 * codes, or not for signing in at all.
 */
const NOT_CODE = new Set([
  'sms',
  'email',
  'recovery',
  'backup',
  'coupon',
  'promo',
  'promotion',
  'discount',
  'voucher',
  'gift',
  'referral',
  'invite',
  'invitation',
  'zip',
  'postal',
  'postcode',
  'captcha',
  'card',
  'cvv',
  'cvc',
  'csc',
  'iban',
  'tracking',
  'search',
  'country',
  'area',
]);

/** The words of identifiers and text: "auth-mfa-otpcode", "totpPin", "Enter code". */
export function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hints(field: FieldInfo): string[] {
  return words(`${field.name} ${field.id} ${field.placeholder} ${field.label}`);
}

function namesCode(found: string[]): boolean {
  const phrase = ` ${found.join(' ')} `;
  return (
    found.some((word) => CODE_WORDS.has(word) || CODE_PREFIXES.some((prefix) => word.startsWith(prefix))) ||
    CODE_PHRASES.some((p) => phrase.includes(` ${p} `))
  );
}

function numeric(field: FieldInfo): boolean {
  return (
    field.inputMode === 'numeric' ||
    field.type === 'tel' ||
    field.type === 'number' ||
    /^(?:\[0-9\]|\\d)/.test(field.pattern) ||
    (field.maxLength >= 4 && field.maxLength <= 10)
  );
}

/** Whether a single input takes a whole code. */
export function isCodeField(field: FieldInfo): boolean {
  if (!TYPES.has(field.type)) return false;
  const autocomplete = field.autocomplete.split(/\s+/).filter(Boolean);
  if (autocomplete.includes('one-time-code')) return true;
  if (autocomplete.some((token) => OTHER_AUTOCOMPLETE.test(token))) return false;
  if (field.maxLength > 0 && (field.maxLength < 4 || field.maxLength > 12)) return false;
  const found = hints(field);
  if (found.some((word) => NOT_CODE.has(word))) return false;
  if (namesCode(found)) return true;
  // "Code" or "Token" alone is a code field only when it also takes digits.
  return field.type !== 'password' && numeric(field) && found.some((word) => word === 'code' || word === 'token');
}

/** Whether inputs of one character each, side by side, take a code a character at a time. */
export function isCodeGroup(fields: FieldInfo[]): boolean {
  // Steam's codes have five characters; TOTP codes six to eight.
  if (fields.length < 5 || fields.length > 8) return false;
  if (!fields.every((field) => TYPES.has(field.type) && field.maxLength === 1)) return false;
  return !fields.some((field) => hints(field).some((word) => NOT_CODE.has(word)));
}
