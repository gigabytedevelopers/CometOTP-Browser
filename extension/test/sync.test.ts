// Keeping the browser's copy current (src/sync/sync.ts, protocol §7.2), over the stand-in storage
// (./fake-browser.ts) and a relay answering in place of fetch.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { blobVersion, buildPayload, randomBytes, sealVault, toBase64Url, type Bytes, type Payload } from '@cometotp/protocol';

import { clearSessionKey, getRecord, setSessionKey } from '../src/lock/storage.js';
import { pairingRecord, storePairing } from '../src/sync/store.js';
import { acceptPending, services, sync } from '../src/sync/sync.js';
import { installBrowser, type FakeIndexedDB } from './fake-browser.js';

const RELAY = 'https://relay.example.com';

/** The relay, as far as downloads go: the vault the phone uploaded, or a status in its place. */
class Relay {
  blob: Bytes | null = null;
  /** Answered instead of the vault, such as 401 or 410. */
  status: { code: number; error: string } | null = null;

  constructor(readonly vault: string, readonly read: string) {
    globalThis.fetch = (input, init) => this.answer(String(input), init ?? {});
  }

  private async answer(url: string, init: RequestInit): Promise<Response> {
    const headers = init.headers as Record<string, string>;
    assert.equal(url, `${RELAY}/v1/vault/${this.vault}`);
    assert.equal(headers.Authorization, `Bearer ${this.read}`);
    const date = { Date: new Date().toUTCString() };
    const error = (code: number, error: string) => Response.json({ error }, { status: code, headers: date });
    if (this.status) return error(this.status.code, this.status.error);
    if (!this.blob) return error(404, 'empty');
    const etag = `"${blobVersion(this.blob)}"`;
    if (headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ...date, ETag: etag } });
    return new Response(this.blob, { status: 200, headers: { ...date, ETag: etag } });
  }
}

const payload = (issuer: string): Payload => ({
  v: 1,
  phone: 'Pixel 7',
  updated: 1_791_763_200,
  services: [{ id: 'AAAAAAAAAAAAAAAA', type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer, label: 'alice' }],
});

let indexedDB: FakeIndexedDB;
let relay: Relay;
let vaultKey: Bytes;
let vaultId: Bytes;
let localKey: Bytes;

/** Version `version` of the vault, its one service named `issuer`. */
const vault = (version: number, issuer = `Version ${version}`) => sealVault(vaultKey, vaultId, version, buildPayload(payload(issuer)));
const unlock = () => setSessionKey(toBase64Url(localKey));
const shown = async () => (await services())?.payload.services.map((s) => s.issuer) ?? null;

beforeEach(async () => {
  ({ indexedDB } = installBrowser());
  vaultKey = randomBytes(32);
  vaultId = randomBytes(16);
  localKey = randomBytes(32);
  const read = toBase64Url(randomBytes(32));
  relay = new Relay(toBase64Url(vaultId), read);
  await storePairing({ relay: RELAY, vault: { id: toBase64Url(vaultId), read, key: toBase64Url(vaultKey) }, phone: 'Pixel 7' }, localKey);
  await unlock();
});

describe('sync', () => {
  it('keeps the newest version when the popup and the background accept versions at once', async () => {
    relay.blob = await vault(1);
    await sync();
    await clearSessionKey();
    relay.blob = await vault(2);
    await sync();
    await unlock();
    // One page has checked version 2, and is about to keep it, when another downloads version 3
    // and keeps that.
    const held = indexedDB.holdNextWrite();
    const slow = acceptPending();
    await held.reached;
    relay.blob = await vault(3);
    await sync();
    held.release();
    await slow;
    assert.equal((await pairingRecord())?.version, 3);
    assert.deepEqual(await shown(), ['Version 3']);
    assert.equal(await getRecord('vault-pending'), undefined);
  });
});
