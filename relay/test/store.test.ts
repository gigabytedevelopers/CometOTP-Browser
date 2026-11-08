// The store's vault totals, which the caps are checked against: kept right by every change, and
// counted for a database made before they were kept.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { RelayStore } from '../src/store.js';

const DAY = 24 * 60 * 60 * 1000;
const NO_CAP = Number.MAX_SAFE_INTEGER;
const hash = new Uint8Array(32);
const blob = (length: number) => new Uint8Array(length).fill(1);

describe('vault totals', () => {
  it('follow uploads, deletes and housekeeping', () => {
    const store = new RelayStore(':memory:');
    const now = Date.UTC(2026, 9, 13);
    for (const id of ['a', 'b', 'c']) store.createVault(id, hash, hash, now, NO_CAP);
    assert.deepEqual(store.totals(), { vaults: 3, vaultBytes: 0 });
    store.putBlob('a', 1, blob(100), NO_CAP);
    store.putBlob('b', 1, blob(300), NO_CAP);
    store.putBlob('a', 2, blob(50), NO_CAP);
    assert.deepEqual(store.totals(), { vaults: 3, vaultBytes: 350 });
    store.deleteVault('b', now);
    assert.deepEqual(store.totals(), { vaults: 2, vaultBytes: 50 });
    // 'a' was never downloaded, so housekeeping deletes it after 7 days.
    store.markRead('c', now);
    store.housekeeping(now + 7 * DAY, 0);
    assert.deepEqual(store.totals(), { vaults: 1, vaultBytes: 0 });
    store.close();
  });

  it('are counted, once, for a database made before they were kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
    try {
      const path = join(dir, 'relay.sqlite');
      const store = new RelayStore(path);
      store.createVault('a', hash, hash, 0, NO_CAP);
      store.createVault('b', hash, hash, 0, NO_CAP);
      store.putBlob('a', 1, blob(100), NO_CAP);
      store.putBlob('b', 1, blob(20), NO_CAP);
      store.close();
      const db = new DatabaseSync(path);
      db.exec('DROP TRIGGER vault_added; DROP TRIGGER vault_stored; DROP TRIGGER vault_deleted; DROP TABLE totals;');
      db.close();

      const upgraded = new RelayStore(path);
      assert.deepEqual(upgraded.totals(), { vaults: 2, vaultBytes: 120 });
      upgraded.putBlob('b', 2, blob(30), NO_CAP);
      upgraded.close();
      const reopened = new RelayStore(path);
      assert.deepEqual(reopened.totals(), { vaults: 2, vaultBytes: 130 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
