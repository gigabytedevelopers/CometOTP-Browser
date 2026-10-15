// The settings that are not secret (src/settings/choices.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AUTO_LOCK_CHOICES, AUTO_LOCK_DEFAULT, autoLockText, nameProblem } from '../src/settings/choices.js';

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
