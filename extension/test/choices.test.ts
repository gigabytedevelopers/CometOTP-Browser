// The settings that are not secret (src/settings/choices.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTO_LOCK_CHOICES,
  AUTO_LOCK_DEFAULT,
  autoLockText,
  idleAction,
  lockAlsoText,
  lockHintText,
  lockReasonText,
  nameProblem,
} from '../src/settings/choices.js';

describe('settings', () => {
  it('offers lock times from a minute to four hours, 15 minutes unless chosen', () => {
    assert.ok(AUTO_LOCK_CHOICES.includes(AUTO_LOCK_DEFAULT));
    assert.equal(AUTO_LOCK_DEFAULT, 15);
    assert.deepEqual(AUTO_LOCK_CHOICES.map(autoLockText), ['1 minute', '5 minutes', '15 minutes', '30 minutes', '1 hour', '4 hours']);
  });

  it('takes a name the pairing code can carry', () => {
    assert.equal(nameProblem('Work laptop'), null);
    assert.equal(nameProblem('  '), 'Give this browser a name.');
    assert.equal(nameProblem('x'.repeat(64)), null);
    assert.equal(nameProblem('x'.repeat(65)), 'That name is too long.');
    // Bytes, not characters: 22 characters of three bytes each are 66.
    assert.equal(nameProblem('文'.repeat(22)), 'That name is too long.');
    assert.equal(nameProblem(' 文 '.repeat(1)), null);
  });
});

describe('locking', () => {
  it('locks when the computer locks only if that is on, and otherwise counts the chosen time again', () => {
    assert.equal(idleAction('locked', true), 'lock');
    assert.equal(idleAction('locked', false), 'start');
    // "idle" is checked against the chosen time, whatever time the browser went by.
    assert.equal(idleAction('idle', true), 'check');
    assert.equal(idleAction('idle', false), 'check');
    assert.equal(idleAction('active', true), 'stop');
    assert.equal(idleAction('active', false), 'stop');
  });

  it('says why it locked, and when', () => {
    assert.equal(lockReasonText({ why: 'idle', at: 0, minutes: 240 }, '14:32'), 'It locked at 14:32 after 4 hours without use.');
    assert.equal(lockReasonText({ why: 'computer', at: 0 }, '14:32'), 'It locked at 14:32, when this computer locked.');
    assert.equal(lockReasonText({ why: 'button', at: 0 }, '14:32'), 'You locked it at 14:32.');
    assert.equal(lockReasonText(null, ''), 'It locked when the browser quit or CometOTP updated.');
  });

  it('says when it locks itself, leaving out the computer where it does not lock with it', () => {
    assert.equal(lockHintText(240, true, false), 'CometOTP locks itself after 4 hours without use, when this computer locks and when the browser quits.');
    assert.equal(lockHintText(240, false, false), 'CometOTP locks itself after 4 hours without use and when the browser quits.');
    assert.equal(lockHintText(5, true, true), 'CometOTP locks itself after 5 minutes without use and when the browser quits.');
    assert.match(lockAlsoText(true, false), /when this computer locks/);
    assert.match(lockAlsoText(false, false), /goes on counting/);
    assert.match(lockAlsoText(true, true), /Firefox does not tell/);
  });
});
