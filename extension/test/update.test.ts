// What the settings page says about updates (src/settings/update.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkedState, startState, updateText } from '../src/settings/update.js';

describe('updates', () => {
  it('says a copy loaded from a folder cannot update itself, and lets a store copy check', () => {
    assert.deepEqual(startState('development'), { kind: 'folder' });
    assert.deepEqual(startState('normal'), { kind: 'idle' });
    assert.deepEqual(startState('admin'), { kind: 'idle' });
    assert.match(updateText({ kind: 'folder' }, '0.1.2'), /cannot update itself/);
  });

  it('reads the store’s answer in Chromium’s shape and in Firefox’s', () => {
    assert.deepEqual(checkedState({ status: 'no_update' }), { kind: 'latest' });
    assert.deepEqual(checkedState({ status: 'throttled' }), { kind: 'throttled' });
    assert.deepEqual(checkedState({ status: 'update_available', version: '0.1.3' }), { kind: 'downloading', version: '0.1.3' });
    assert.deepEqual(checkedState({ status: 'update_available', details: { version: '0.1.3' } }), { kind: 'downloading', version: '0.1.3' });
    assert.deepEqual(checkedState({ status: 'update_available' }), { kind: 'downloading', version: null });
  });

  it('says what happens next', () => {
    assert.equal(updateText({ kind: 'latest' }, '0.1.2'), 'CometOTP 0.1.2 is the latest version.');
    assert.match(updateText({ kind: 'downloading', version: '0.1.3' }, '0.1.2'), /^Version 0\.1\.3 is downloading\. .*locks/);
    assert.match(updateText({ kind: 'downloading', version: null }, '0.1.2'), /^A new version is downloading/);
    assert.match(updateText({ kind: 'installing', version: '0.1.3' }, '0.1.2'), /^Installing version 0\.1\.3: .*this page closes/);
    assert.equal(updateText({ kind: 'failed', reason: 'offline' }, '0.1.2'), 'Could not check for updates: offline');
  });
});
