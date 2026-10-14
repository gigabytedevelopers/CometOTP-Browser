// The password strength estimate behind the setup screen's meter (src/lock/strength.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_LENGTH, MIN_SCORE, problem, score } from '../src/lock/strength.js';

describe('password strength', () => {
  it('refuses short passwords whatever they look like', () => {
    assert.equal(MIN_LENGTH, 10);
    assert.match(problem('Xk9$vQ2!m')!, /at least 10/);
  });

  it('rates common passwords and their usual variants very weak', () => {
    for (const password of ['password12', 'Password123!', 'P@ssw0rd2024', 'qwertyuiop', '1234567890', 'cometotp!!']) {
      assert.equal(score(password), 0, password);
      assert.ok(problem(password), password);
    }
  });

  it('sees through repeats and runs', () => {
    for (const password of ['aaaaaaaaaaaa', 'abcdefghijkl', '1111122222', 'qwertyasdfgh']) {
      assert.ok(score(password) < MIN_SCORE, password);
    }
  });

  it('accepts a few unrelated words, and rates longer mixed passwords higher', () => {
    assert.equal(problem('orbit lantern pickle'), null);
    assert.ok(score('orbit lantern pickle') >= 3);
    assert.equal(score('7Tq!vZp2#Lw9@eRm'), 4);
    assert.ok(score('tulipmarble') >= MIN_SCORE);
  });

  it('counts characters, not UTF-16 units, toward the length', () => {
    assert.equal(problem('🔑🔑🔑🔑🔑'), `Use at least ${MIN_LENGTH} characters.`);
  });
});
