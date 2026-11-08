// The lock as the popup and the background use it (src/lock/lock.ts), over the stand-in IndexedDB
// and storage.session (./fake-browser.ts): set up, locked and unlocked, a new password, a passkey,
// a reset, and changes that overlap, as a page and the background, or two pages, may make them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { randomBytes, toBase64Url } from '@cometotp/protocol';

import {
  addPasskey,
  changePassword,
  localKey,
  lock,
  passkeyCredential,
  removePasskey,
  reset,
  setUp,
  state,
  unlock,
  unlockWithPasskey,
} from '../src/lock/lock.js';
import { getRecord, putRecord } from '../src/lock/storage.js';
import { pairingRecord, storePairing } from '../src/sync/store.js';
import { installBrowser } from './fake-browser.js';

const PASSWORD = 'orbit lantern pickle';
const NEXT = 'quartz meadow lantern';

describe('the lock, over its storage', () => {
  it('is new, then unlocked once set up, and locks and unlocks to the same local key', async () => {
    installBrowser();
    assert.equal(await state(), 'new');
    await setUp(PASSWORD);
    assert.equal(await state(), 'unlocked');
    const key = await localKey();
    assert.equal(key?.length, 32);
    await assert.rejects(setUp(NEXT), /already/);
    await lock();
    assert.equal(await state(), 'locked');
    assert.equal(await localKey(), null);
    assert.equal(await unlock(NEXT), false);
    assert.equal(await state(), 'locked');
    assert.equal(await unlock(PASSWORD), true);
    assert.deepEqual(await localKey(), key);
  });

  it('takes a new password, given the current one, around the same local key', async () => {
    installBrowser();
    await setUp(PASSWORD);
    const key = await localKey();
    await lock();
    assert.equal(await changePassword(NEXT, PASSWORD), false);
    assert.equal(await changePassword(PASSWORD, NEXT), true);
    assert.equal(await state(), 'locked');
    assert.equal(await unlock(PASSWORD), false);
    assert.equal(await unlock(NEXT), true);
    assert.deepEqual(await localKey(), key);
  });

  it('adds a passkey only while unlocked, unlocks with it, and removes it', async () => {
    installBrowser();
    await setUp(PASSWORD);
    const key = await localKey();
    const prf = randomBytes(32);
    await addPasskey('credential', prf);
    assert.equal(await passkeyCredential(), 'credential');
    await lock();
    await assert.rejects(addPasskey('other', randomBytes(32)), /Unlock first/);
    assert.equal(await unlockWithPasskey(randomBytes(32)), false);
    assert.equal(await unlockWithPasskey(prf), true);
    assert.deepEqual(await localKey(), key);
    await removePasskey();
    assert.equal(await passkeyCredential(), null);
    await lock();
    assert.equal(await unlockWithPasskey(prf), false);
  });

  it('keeps a passkey removed while a new password was being made removed', async () => {
    const { indexedDB } = installBrowser();
    await setUp(PASSWORD);
    await addPasskey('credential', randomBytes(32));
    const held = indexedDB.holdNextWrite();
    const changing = changePassword(PASSWORD, NEXT);
    // Argon2 is done and the new password waits to be written; the passkey goes meanwhile.
    await held.reached;
    await removePasskey();
    held.release();
    assert.equal(await changing, true);
    assert.equal(await passkeyCredential(), null);
    await lock();
    assert.equal(await unlock(NEXT), true);
  });

  it('keeps a passkey added while a new password was being made', async () => {
    const { indexedDB } = installBrowser();
    await setUp(PASSWORD);
    const prf = randomBytes(32);
    const held = indexedDB.holdNextWrite();
    const changing = changePassword(PASSWORD, NEXT);
    await held.reached;
    await addPasskey('credential', prf);
    held.release();
    assert.equal(await changing, true);
    assert.equal(await passkeyCredential(), 'credential');
    await lock();
    assert.equal(await unlockWithPasskey(prf), true);
    await lock();
    assert.equal(await unlock(NEXT), true);
  });

  it('does not write a new password over a lock reset and set up meanwhile', async () => {
    const { indexedDB } = installBrowser();
    await setUp(PASSWORD);
    const held = indexedDB.holdNextWrite();
    const changing = changePassword(PASSWORD, NEXT);
    await held.reached;
    await reset();
    await setUp('another unrelated phrase');
    held.release();
    assert.equal(await changing, false);
    await lock();
    assert.equal(await unlock(NEXT), false);
    assert.equal(await unlock('another unrelated phrase'), true);
  });

  it('forgets the password and everything else on reset', async () => {
    installBrowser();
    await setUp(PASSWORD);
    await putRecord('auto-lock', 5);
    await reset();
    assert.equal(await state(), 'new');
    assert.equal(await localKey(), null);
    assert.equal(await getRecord('auto-lock'), undefined);
  });

  it('deletes the vault on the relay first when paired, even while locked, and resets if it cannot', async () => {
    for (const reachable of [true, false]) {
      installBrowser();
      await setUp(PASSWORD);
      const vault = { id: toBase64Url(randomBytes(16)), read: toBase64Url(randomBytes(32)), key: toBase64Url(randomBytes(32)) };
      await storePairing({ relay: 'https://relay.example.com', vault, phone: 'Pixel 7' }, (await localKey())!);
      await lock();
      const calls: string[] = [];
      globalThis.fetch = async (input, init) => {
        calls.push(`${init?.method} ${String(input)} ${(init?.headers as Record<string, string>).Authorization}`);
        if (!reachable) throw new TypeError('fetch failed');
        return new Response(null, { status: 204 });
      };
      await reset();
      assert.deepEqual(calls, [`DELETE https://relay.example.com/v1/vault/${vault.id} Bearer ${vault.read}`]);
      assert.equal(await state(), 'new');
      assert.equal(await pairingRecord(), null);
    }
  });
});
