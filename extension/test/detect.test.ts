// Which inputs get the CometOTP button (src/fill/detect.ts): code fields modelled on well-known
// sign-in pages, and fields that only look like them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isCodeField, isCodeGroup, words, type FieldInfo } from '../src/fill/detect.js';

function field(info: Partial<FieldInfo>): FieldInfo {
  return { type: 'text', autocomplete: '', name: '', id: '', placeholder: '', label: '', maxLength: -1, inputMode: '', pattern: '', ...info };
}

describe('words', () => {
  it('splits identifiers and text into lowercase words', () => {
    assert.deepEqual(words('auth-mfa-otpcode'), ['auth', 'mfa', 'otpcode']);
    assert.deepEqual(words('totpPin'), ['totp', 'pin']);
    assert.deepEqual(words('idTxtBx_SAOTCC_OTC'), ['id', 'txt', 'bx', 'saotcc', 'otc']);
    assert.deepEqual(words('Enter the 6-digit code'), ['enter', 'the', '6', 'digit', 'code']);
  });

  it('parts digits from the letters before them, but not from those after', () => {
    assert.deepEqual(words('zip1'), ['zip', '1']);
    assert.deepEqual(words('smsCode2'), ['sms', 'code', '2']);
    assert.deepEqual(words('otp_digit_10'), ['otp', 'digit', '10']);
    assert.deepEqual(words('auth2fa'), ['auth', '2fa']);
  });
});

describe('isCodeField', () => {
  it('finds code fields as well-known sign-in pages mark them', () => {
    const pages: Record<string, Partial<FieldInfo>> = {
      // autocomplete="one-time-code" says it outright.
      'GitHub': { name: 'app_otp', id: 'app_totp', autocomplete: 'one-time-code', inputMode: 'numeric', maxLength: 6, placeholder: 'XXXXXX' },
      'Google': { type: 'tel', name: 'totpPin', id: 'totpPin', autocomplete: 'off', label: 'Enter code', pattern: '[0-9 ]*' },
      'Microsoft': { type: 'tel', name: 'otc', id: 'idTxtBx_SAOTCC_OTC', autocomplete: 'off', maxLength: 6, placeholder: 'Code', label: 'Code' },
      'AWS': { name: 'mfaCode', id: 'mfaCode', autocomplete: 'off', label: 'MFA code' },
      'Amazon': { type: 'tel', name: 'otpCode', id: 'auth-mfa-otpcode', autocomplete: 'off', maxLength: 6, placeholder: 'Enter OTP' },
      'a code labelled in words': { name: 'code', label: 'Authentication code', inputMode: 'numeric' },
      'a two-factor token': { name: 'twoFactorToken', label: 'Two-factor code' },
      'a hidden code': { type: 'password', name: 'verification_code', label: 'Verification code', maxLength: 6 },
      'a bare code that takes digits': { name: 'code', inputMode: 'numeric', maxLength: 6 },
    };
    for (const [page, info] of Object.entries(pages)) assert.ok(isCodeField(field(info)), page);
  });

  it('leaves other fields alone, including codes CometOTP does not have', () => {
    const others: Record<string, Partial<FieldInfo>> = {
      'an email address': { type: 'email', name: 'email', autocomplete: 'username' },
      'a username': { name: 'login', autocomplete: 'username' },
      'a password': { type: 'password', name: 'password', autocomplete: 'current-password' },
      'a search box': { type: 'search', name: 'q' },
      'a checkbox': { type: 'checkbox', name: 'otp_remember' },
      'a coupon code': { name: 'coupon_code', inputMode: 'numeric', maxLength: 8 },
      'a postal code': { name: 'zip', autocomplete: 'postal-code', maxLength: 5 },
      'a card security code': { name: 'cvc', label: 'Security code', maxLength: 4 },
      'a code sent by text': { name: 'sms_code', label: 'Enter the code we texted you', inputMode: 'numeric', maxLength: 6 },
      'a code sent by email': { name: 'code', label: 'Code from your email', inputMode: 'numeric' },
      'a recovery code': { name: 'recovery_code', label: 'Recovery code' },
      'a captcha': { name: 'captcha_code', label: 'Type the characters' },
      'a phone number': { type: 'tel', name: 'phone', autocomplete: 'tel' },
      'a word that only contains "otp"': { name: 'footprint' },
      'a bare code without digits': { name: 'code' },
      'a long field': { name: 'otp', maxLength: 64 },
      'a card security code numbered as it is on the card': { name: 'cvv2', label: 'Security code', maxLength: 4 },
      'a code sent by text, numbered': { name: 'sms1', label: 'Code', inputMode: 'numeric', maxLength: 6 },
    };
    for (const [what, info] of Object.entries(others)) assert.ok(!isCodeField(field(info)), what);
  });
});

describe('isCodeGroup', () => {
  const box = (info: Partial<FieldInfo> = {}) => field({ maxLength: 1, inputMode: 'numeric', ...info });

  it('finds a box per digit, and Steam’s five', () => {
    assert.ok(isCodeGroup(Array.from({ length: 6 }, () => box())));
    assert.ok(isCodeGroup(Array.from({ length: 8 }, () => box({ type: 'tel' }))));
    assert.ok(isCodeGroup(Array.from({ length: 5 }, () => box({ inputMode: '' }))));
  });

  it('refuses too few or too many boxes, wider boxes, and boxes for something else', () => {
    assert.ok(!isCodeGroup(Array.from({ length: 4 }, () => box())));
    assert.ok(!isCodeGroup(Array.from({ length: 9 }, () => box())));
    assert.ok(!isCodeGroup([...Array.from({ length: 5 }, () => box()), box({ maxLength: 2 })]));
    assert.ok(!isCodeGroup(Array.from({ length: 6 }, () => box({ type: 'checkbox' }))));
    assert.ok(!isCodeGroup(Array.from({ length: 6 }, (_, i) => box({ name: `sms_${i}` }))));
  });

  it('refuses boxes that say they are something else, in their autocomplete or with a number in their name', () => {
    const groups: Record<string, FieldInfo[]> = {
      'a date of birth': ['bday-day', 'bday-day', 'bday-month', 'bday-month', 'bday-year', 'bday-year', 'bday-year', 'bday-year'].map((autocomplete) =>
        box({ autocomplete }),
      ),
      'a postal code': Array.from({ length: 5 }, () => box({ autocomplete: 'postal-code' })),
      'a card number': Array.from({ length: 8 }, () => box({ autocomplete: 'cc-number' })),
      'a phone number': Array.from({ length: 7 }, () => box({ autocomplete: 'tel-local' })),
      'one box of a postal code among code boxes': [...Array.from({ length: 5 }, () => box()), box({ autocomplete: 'shipping postal-code' })],
      'boxes named zip1 to zip5': Array.from({ length: 5 }, (_, i) => box({ name: `zip${i + 1}` })),
      'boxes named sms1 to sms6': Array.from({ length: 6 }, (_, i) => box({ id: `sms${i + 1}` })),
    };
    for (const [what, fields] of Object.entries(groups)) assert.ok(!isCodeGroup(fields), what);
    // Boxes marked as a code, or numbered without saying anything else, are still a code's.
    assert.ok(isCodeGroup(Array.from({ length: 6 }, (_, i) => box({ autocomplete: i ? 'off' : 'one-time-code', name: `otp${i + 1}` }))));
    assert.ok(isCodeGroup(Array.from({ length: 6 }, (_, i) => box({ name: `digit${i + 1}` }))));
  });
});
