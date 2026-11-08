// Keeping the browser's copy current (src/sync/sync.ts, protocol §7.2), over the stand-in storage
// (./fake-browser.ts) and a relay answering in place of fetch.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { MAX_BLOB_LENGTH, PAD_BLOCK, blobVersion, buildPayload, concat, randomBytes, sealVault, toBase64Url, type Bytes, type Payload } from '@cometotp/protocol';

import { addLink, readHidden, readLinks, removeLink } from '../src/fill/links.js';
import { clearSessionKey, getRecord, putRecord, setSessionKey } from '../src/lock/storage.js';
import { pairingRecord, storePairing } from '../src/sync/store.js';
import { acceptPending, disconnect, notice, services, sync, syncStatus } from '../src/sync/sync.js';
import { installBrowser, type FakeIndexedDB } from './fake-browser.js';

const RELAY = 'https://relay.example.com';

/** The relay, as far as the browser goes: the vault the phone uploaded, or a status in its place. */
class Relay {
  blob: Bytes | null = null;
  /** Answered instead of the vault, such as 401 or 410. */
  status: { code: number; error: string } | null = null;
  reachable = true;
  /** Answered in place of the vault, for downloads that are not one. */
  download: (() => Response) | null = null;
  /** The version each download said it had, from If-None-Match. */
  had: (string | undefined)[] = [];

  constructor(readonly vault: string, readonly read: string) {
    globalThis.fetch = (input, init) => this.answer(String(input), init ?? {});
  }

  private async answer(url: string, init: RequestInit): Promise<Response> {
    if (!this.reachable) throw new TypeError('fetch failed');
    const headers = init.headers as Record<string, string>;
    this.had.push(headers['If-None-Match']);
    assert.equal(url, `${RELAY}/v1/vault/${this.vault}`);
    assert.equal(headers.Authorization, `Bearer ${this.read}`);
    const date = { Date: new Date().toUTCString() };
    const error = (code: number, error: string) => Response.json({ error }, { status: code, headers: date });
    if (this.status) return error(this.status.code, this.status.error);
    if (init.method === 'DELETE') {
      this.blob = null;
      return new Response(null, { status: 204, headers: date });
    }
    if (this.download) return this.download();
    if (!this.blob) return error(404, 'empty');
    const etag = `"${blobVersion(this.blob)}"`;
    if (headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ...date, ETag: etag } });
    return new Response(this.blob, { status: 200, headers: { ...date, ETag: etag } });
  }
}

/** The vault's one service, and one it does not have. */
const SERVICE = 'AAAAAAAAAAAAAAAA';
const GONE = 'BBBBBBBBBBBBBBBB';

const payload = (issuer: string): Payload => ({
  v: 1,
  phone: 'Pixel 7',
  updated: 1_791_763_200,
  services: [{ id: SERVICE, type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer, label: 'alice' }],
});

let indexedDB: FakeIndexedDB;
let relay: Relay;
let vaultKey: Bytes;
let vaultId: Bytes;
let localKey: Bytes;
let read: string;

/** Version `version` of the vault, its one service named `issuer`. */
const vault = (version: number, issuer = `Version ${version}`) => sealVault(vaultKey, vaultId, version, buildPayload(payload(issuer)));
const pair = () => storePairing({ relay: RELAY, vault: { id: toBase64Url(vaultId), read, key: toBase64Url(vaultKey) }, phone: 'Pixel 7' }, localKey);
const unlock = () => setSessionKey(toBase64Url(localKey));
const lock = () => clearSessionKey();
const shown = async () => (await services())?.payload.services.map((s) => s.issuer) ?? null;

beforeEach(async () => {
  ({ indexedDB } = installBrowser());
  vaultKey = randomBytes(32);
  vaultId = randomBytes(16);
  localKey = randomBytes(32);
  read = toBase64Url(randomBytes(32));
  relay = new Relay(toBase64Url(vaultId), read);
  await pair();
  await unlock();
});

describe('sync', () => {
  it('downloads the first version, then nothing while it is unchanged', async () => {
    relay.blob = await vault(1);
    await sync();
    assert.deepEqual(await shown(), ['Version 1']);
    assert.equal((await pairingRecord())?.version, 1);
    await sync();
    assert.deepEqual(relay.had, [undefined, '"1"']);
    assert.equal((await syncStatus()).warning, null);
  });

  it('keeps a version downloaded while locked aside, still sealed, and takes it at the next unlock', async () => {
    relay.blob = await vault(1);
    await sync();
    await lock();
    relay.blob = await vault(2);
    await sync();
    assert.equal((await pairingRecord())?.version, 1);
    assert.equal(((await getRecord('vault-pending')) as { version: number }).version, 2);
    assert.equal(await services(), null);
    // Downloading again while locked asks for the version kept aside, which costs one 304.
    await sync();
    assert.equal(relay.had.at(-1), '"2"');
    await unlock();
    await acceptPending();
    assert.equal((await pairingRecord())?.version, 2);
    assert.deepEqual(await shown(), ['Version 2']);
    assert.equal(await getRecord('vault-pending'), undefined);
  });

  it('replaces a version kept aside with a made-up high number by the next real one', async () => {
    relay.blob = await vault(1);
    await sync();
    await lock();
    // Version 999, as far as anyone can tell without the vault key, which is under the lock.
    relay.blob = await sealVault(randomBytes(32), vaultId, 999, buildPayload(payload('Fake')));
    await sync();
    assert.equal(((await getRecord('vault-pending')) as { version: number }).version, 999);
    relay.blob = await vault(2);
    await sync();
    assert.equal(relay.had.at(-1), '"999"');
    assert.equal(((await getRecord('vault-pending')) as { version: number }).version, 2);
    await unlock();
    await acceptPending();
    assert.deepEqual(await shown(), ['Version 2']);
    assert.equal((await syncStatus()).warning, null);
  });

  it('says so when a version kept aside does not open, and keeps the copy', async () => {
    relay.blob = await vault(1);
    await sync();
    await lock();
    relay.blob = await sealVault(randomBytes(32), vaultId, 2, buildPayload(payload('Fake')));
    await sync();
    await unlock();
    await acceptPending();
    assert.equal((await syncStatus()).warning, 'bad-vault');
    assert.deepEqual(await shown(), ['Version 1']);
    assert.equal((await pairingRecord())?.version, 1);
  });

  it('warns of an older version than the one accepted, and keeps the copy', async () => {
    relay.blob = await vault(2);
    await sync();
    relay.blob = await vault(1);
    await sync();
    assert.equal((await syncStatus()).warning, 'rollback');
    assert.deepEqual(await shown(), ['Version 2']);
    assert.equal((await pairingRecord())?.version, 2);
    assert.equal(await getRecord('vault-pending'), undefined);
  });

  it('deletes everything the pairing kept once the phone removed the browser (410), and says so', async () => {
    relay.blob = await vault(1);
    await sync();
    await putRecord('site-links', { nonce: 'n', sealed: 's' });
    await lock();
    relay.blob = await vault(2);
    await sync();
    relay.status = { code: 410, error: 'gone' };
    await sync();
    for (const record of ['pairing', 'vault-secret', 'vault-blob', 'vault-pending', 'site-links', 'sync-status']) {
      assert.equal(await getRecord(record), undefined, record);
    }
    assert.equal(await notice(), 'disconnected');
  });

  it('keeps the copy when the relay no longer knows the browser (401, 404), and says to pair again', async () => {
    relay.blob = await vault(1);
    await sync();
    for (const status of [
      { code: 401, error: 'unauthorized' },
      { code: 404, error: 'not_found' },
    ]) {
      relay.status = status;
      await sync();
      assert.equal((await syncStatus()).warning, 'repair', String(status.code));
      assert.deepEqual(await shown(), ['Version 1']);
      assert.equal((await pairingRecord())?.version, 1);
    }
  });

  it('keeps the copy when the relay cannot be reached, and when it has no vault yet', async () => {
    relay.blob = await vault(1);
    await sync();
    const { checkedAt } = await syncStatus();
    relay.reachable = false;
    await sync();
    assert.equal((await syncStatus()).warning, 'unreachable');
    assert.equal((await syncStatus()).checkedAt, checkedAt);
    assert.deepEqual(await shown(), ['Version 1']);
    relay.reachable = true;
    relay.blob = null;
    await sync();
    assert.equal((await syncStatus()).warning, null);
    assert.deepEqual(await shown(), ['Version 1']);
  });

  it('keeps nothing larger than a vault can be, or of a length no vault has, and keeps the copy', async () => {
    relay.blob = await vault(1);
    await sync();
    const real = await vault(2);
    let read = 0;
    /** A body that never ends, as a relay could send, counting what was read of it. */
    const endless = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            read += 65536;
            controller.enqueue(new Uint8Array(65536));
          },
        },
        { highWaterMark: 0 },
      );
    const answers: Record<string, () => Response> = {
      'a body over the limit': () => new Response(new Uint8Array(MAX_BLOB_LENGTH + PAD_BLOCK)),
      'a vault with a byte more': () => new Response(concat(real, new Uint8Array(1))),
      'a vault cut short': () => new Response(real.subarray(0, real.length - 1)),
      'a body that never ends': () => new Response(endless()),
      'a Content-Length over the limit': () => new Response(endless(), { headers: { 'Content-Length': String(MAX_BLOB_LENGTH + 1) } }),
    };
    for (const [what, answer] of Object.entries(answers)) {
      read = 0;
      relay.download = answer;
      await sync();
      assert.equal((await syncStatus()).warning, 'bad-vault', what);
      assert.equal(await getRecord('vault-pending'), undefined, what);
      assert.deepEqual(await shown(), ['Version 1'], what);
      assert.ok(read <= MAX_BLOB_LENGTH + 2 * 65536, `${what}: read ${read} bytes`);
    }
    assert.equal(read, 0, 'A Content-Length over the limit was read');
    relay.download = null;
    relay.blob = real;
    await sync();
    assert.deepEqual(await shown(), ['Version 2']);
  });

  it('disconnects, deleting the vault on the relay, also when the relay no longer knows the browser', async () => {
    for (const status of [null, { code: 401, error: 'unauthorized' }, { code: 404, error: 'not_found' }, { code: 410, error: 'gone' }]) {
      relay.blob = await vault(1);
      await sync();
      relay.status = status;
      assert.equal(await disconnect(), true, String(status?.code));
      assert.equal(await pairingRecord(), null);
      assert.equal(await getRecord('vault-blob'), undefined);
      if (!status) assert.equal(relay.blob, null);
      relay.status = null;
      await pair();
    }
    relay.reachable = false;
    assert.equal(await disconnect(), false);
    assert.equal(await pairingRecord(), null);
  });

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

  it('forgets the sites of services no longer in the vault once it takes a version without them', async () => {
    relay.blob = await vault(1);
    await sync();
    await addLink(localKey, SERVICE, 'github.com');
    await addLink(localKey, GONE, 'gitlab.com');
    await removeLink(localKey, { id: GONE, issuer: 'GitHub' }, 'github.com');
    // An unchanged vault leaves them.
    await sync();
    assert.deepEqual(Object.keys(await readLinks(localKey)), [SERVICE, GONE]);
    relay.blob = await vault(2);
    await sync();
    assert.deepEqual(await readLinks(localKey), { [SERVICE]: ['github.com'] });
    assert.deepEqual(await readHidden(localKey), {});
  });

  it('keeps the sites while the vault has a service it cannot read, which may be the one linked', async () => {
    relay.blob = await vault(1);
    await sync();
    await addLink(localKey, GONE, 'gitlab.com');
    const json = JSON.parse(buildPayload(payload('Version 2'))) as { services: unknown[] };
    json.services.push({ id: GONE, type: 'a type from later' });
    relay.blob = await sealVault(vaultKey, vaultId, 2, JSON.stringify(json));
    await sync();
    assert.deepEqual(await shown(), ['Version 2']);
    assert.deepEqual(await readLinks(localKey), { [GONE]: ['gitlab.com'] });
  });
});
