// The relay's API (protocol §6), end to end over HTTP, with an in-memory database and a clock the
// tests move. Blobs are real vaults sealed with @cometotp/protocol.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { MAX_BLOB_LENGTH, PAD_BLOCK, buildPayload, fromBase64Url, sealVault, toBase64Url } from '@cometotp/protocol';

import { MAX_FRAME, MAX_MESSAGES, createRelay, type Relay } from '../src/app.js';
import { DEFAULT_LIMITS, type RelayConfig } from '../src/config.js';
import { RelayStore } from '../src/store.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let clock = Date.UTC(2026, 9, 13, 12);
let base = '';
let server: Server;
let relay: Relay;
let store: RelayStore;

const config: RelayConfig = {
  port: 0,
  host: '127.0.0.1',
  databasePath: ':memory:',
  trustProxy: true,
  longPollMs: 300,
  limits: { ...DEFAULT_LIMITS },
};

function start(limits = DEFAULT_LIMITS): Promise<void> {
  config.limits = { ...limits };
  store = new RelayStore(':memory:');
  relay = createRelay(config, store, () => clock);
  server = createServer((req, res) => void relay.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

function stop(): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      store.close();
      resolve();
    });
  });
}

interface Options {
  token?: string;
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
  ip?: string;
}

async function call(method: string, path: string, options: Options = {}) {
  const headers: Record<string, string> = { 'X-Forwarded-For': options.ip ?? '203.0.113.1', ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: string | Uint8Array<ArrayBuffer> | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.body) {
    headers['Content-Type'] = 'application/octet-stream';
    body = new Uint8Array(options.body);
  }
  const response = await fetch(base + path, { method, headers, body });
  const raw = new Uint8Array(await response.arrayBuffer());
  const text = Buffer.from(raw).toString('utf8');
  const isJson = response.headers.get('content-type') === 'application/json';
  return { status: response.status, headers: response.headers, raw, json: isJson ? JSON.parse(text) : undefined };
}

const id16 = () => toBase64Url(randomBytes(16));
const token32 = () => randomBytes(32);
const hash = (bytes: Uint8Array) => toBase64Url(createHash('sha256').update(bytes).digest());
const frame = (length = 100) => ({ m: toBase64Url(randomBytes(length)) });

describe('relay', () => {
  before(() => start());
  after(() => stop());
  beforeEach(() => {
    clock = Date.UTC(2026, 9, 13, 12);
  });

  describe('general', () => {
    it('says which protocol it speaks, with CORS and no caching', async () => {
      const r = await call('GET', '/v1/');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { protocol: 1 });
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
      assert.equal(r.headers.get('access-control-expose-headers'), 'Date, ETag, Retry-After');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    });

    it('answers preflights', async () => {
      const r = await call('OPTIONS', `/v1/vault/${id16()}`, { headers: { 'Access-Control-Request-Method': 'PUT' } });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-methods'), 'GET, POST, PUT, DELETE');
      assert.equal(r.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, If-None-Match');
    });

    it('refuses unknown paths and malformed ids', async () => {
      assert.deepEqual((await call('GET', '/v2/')).json, { error: 'not_found' });
      assert.equal((await call('PATCH', `/v1/vault/${id16()}`)).status, 404);
      assert.deepEqual((await call('GET', '/v1/vault/short')).json, { error: 'bad_request' });
      assert.equal((await call('PUT', `/v1/pair/${toBase64Url(randomBytes(17))}`)).status, 400);
    });
  });

  describe('pairing channels', () => {
    async function channel() {
      const id = id16();
      const r = await call('PUT', `/v1/pair/${id}`);
      assert.equal(r.status, 201);
      return { id, browser: r.json.token as string };
    }

    async function claimed() {
      const c = await channel();
      const r = await call('POST', `/v1/pair/${c.id}/to-browser`, { json: frame() });
      assert.equal(r.status, 201);
      assert.equal(r.json.seq, 1);
      return { ...c, phone: r.json.token as string };
    }

    it('runs a whole exchange in both directions', async () => {
      const c = await channel();
      assert.deepEqual((await call('PUT', `/v1/pair/${c.id}`)).json, { error: 'exists' });
      const hello = frame(178);
      const claim = await call('POST', `/v1/pair/${c.id}/to-browser`, { json: hello });
      assert.equal(claim.status, 201);
      const phone = claim.json.token as string;
      assert.match(phone, /^[A-Za-z0-9_-]{43}$/);

      const forBrowser = await call('GET', `/v1/pair/${c.id}/to-browser?after=0`, { token: c.browser });
      assert.deepEqual(forBrowser.json, { messages: [{ seq: 1, m: hello.m }] });

      const confirm = frame(40);
      assert.deepEqual((await call('POST', `/v1/pair/${c.id}/to-phone`, { token: c.browser, json: confirm })).json, { seq: 1 });
      assert.deepEqual((await call('GET', `/v1/pair/${c.id}/to-phone?after=0`, { token: phone })).json, {
        messages: [{ seq: 1, m: confirm.m }],
      });
      assert.deepEqual((await call('POST', `/v1/pair/${c.id}/to-browser`, { token: phone, json: frame() })).json, { seq: 2 });
      assert.deepEqual(
        (await call('GET', `/v1/pair/${c.id}/to-browser?after=1`, { token: c.browser })).json.messages.map((m: { seq: number }) => m.seq),
        [2],
      );
    });

    it('lets only one phone claim a channel', async () => {
      const c = await claimed();
      assert.deepEqual((await call('POST', `/v1/pair/${c.id}/to-browser`, { json: frame() })).json, { error: 'claimed' });
      assert.equal((await call('POST', `/v1/pair/${c.id}/to-browser`, { token: c.browser, json: frame() })).status, 401);
    });

    it('checks who may post and read each direction', async () => {
      const c = await channel();
      assert.deepEqual((await call('POST', `/v1/pair/${c.id}/to-phone`, { token: c.browser, json: frame() })).json, {
        error: 'not_claimed',
      });
      assert.equal((await call('GET', `/v1/pair/${c.id}/to-phone`, { token: c.browser })).status, 401);
      const p = await call('POST', `/v1/pair/${c.id}/to-browser`, { json: frame() });
      const phone = p.json.token as string;
      assert.equal((await call('POST', `/v1/pair/${c.id}/to-phone`, { token: phone, json: frame() })).status, 401);
      assert.equal((await call('GET', `/v1/pair/${c.id}/to-browser`, { token: phone })).status, 401);
      assert.equal((await call('GET', `/v1/pair/${c.id}/to-browser`)).status, 401);
      assert.equal((await call('GET', `/v1/pair/${c.id}/to-browser?after=x`, { token: c.browser })).status, 400);
    });

    it('limits frames and messages', async () => {
      const c = await claimed();
      assert.deepEqual((await call('POST', `/v1/pair/${c.id}/to-phone`, { token: c.browser, json: frame(MAX_FRAME + 1) })).json, {
        error: 'too_large',
      });
      assert.equal((await call('POST', `/v1/pair/${c.id}/to-phone`, { token: c.browser, json: { m: '' } })).status, 400);
      assert.equal((await call('POST', `/v1/pair/${c.id}/to-phone`, { token: c.browser, json: { m: 'A=' } })).status, 400);
      for (let i = 1; i <= MAX_MESSAGES; i++) {
        assert.equal((await call('POST', `/v1/pair/${c.id}/to-phone`, { token: c.browser, json: frame(MAX_FRAME) })).status, 201);
      }
      assert.deepEqual((await call('POST', `/v1/pair/${c.id}/to-phone`, { token: c.browser, json: frame() })).json, { error: 'full' });
    });

    it('wakes a waiting reader as soon as a message arrives', async () => {
      const c = await claimed();
      const waiting = call('GET', `/v1/pair/${c.id}/to-phone?after=0`, { token: c.phone });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const confirm = frame(40);
      await call('POST', `/v1/pair/${c.id}/to-phone`, { token: c.browser, json: confirm });
      assert.deepEqual((await waiting).json, { messages: [{ seq: 1, m: confirm.m }] });
    });

    it('answers a long poll with no messages once it has waited', async () => {
      const c = await claimed();
      const started = Date.now();
      assert.deepEqual((await call('GET', `/v1/pair/${c.id}/to-phone`, { token: c.phone })).json, { messages: [] });
      assert.ok(Date.now() - started >= config.longPollMs - 20);
    });

    it('takes a hello only within two minutes of the channel being made', async () => {
      const c = await channel();
      clock += 2 * MINUTE;
      assert.deepEqual((await call('POST', `/v1/pair/${c.id}/to-browser`, { json: frame() })).json, { error: 'expired' });
    });

    it('expires a channel after ten minutes, or when deleted, and keeps its id taken a while', async () => {
      const c = await claimed();
      clock += 10 * MINUTE - 1;
      assert.equal((await call('GET', `/v1/pair/${c.id}/to-browser`, { token: c.browser })).status, 200);
      clock += 1;
      assert.deepEqual((await call('GET', `/v1/pair/${c.id}/to-browser`, { token: c.browser })).json, { error: 'expired' });

      const d = await claimed();
      assert.equal((await call('DELETE', `/v1/pair/${d.id}`, { token: d.browser.replace(/^./, 'A') })).status, 401);
      assert.equal((await call('DELETE', `/v1/pair/${d.id}`, { token: d.phone })).status, 204);
      assert.deepEqual((await call('POST', `/v1/pair/${d.id}/to-phone`, { token: d.browser, json: frame() })).json, {
        error: 'expired',
      });
      assert.deepEqual((await call('PUT', `/v1/pair/${d.id}`)).json, { error: 'exists' });
      clock += 20 * MINUTE;
      relay.housekeeping();
      assert.equal((await call('GET', `/v1/pair/${d.id}/to-browser`, { token: d.browser })).status, 404);
      assert.equal((await call('PUT', `/v1/pair/${d.id}`)).status, 201);
    });

    it('ends a waiting reader when the channel is deleted', async () => {
      const c = await claimed();
      const waiting = call('GET', `/v1/pair/${c.id}/to-phone`, { token: c.phone });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await call('DELETE', `/v1/pair/${c.id}`, { token: c.browser });
      assert.deepEqual((await waiting).json, { error: 'expired' });
    });
  });

  describe('vaults', () => {
    async function vault() {
      const id = id16();
      const write = token32();
      const read = token32();
      const key = randomBytes(32);
      const r = await call('POST', '/v1/vaults', { json: { id, write: hash(write), read: hash(read) } });
      assert.equal(r.status, 201);
      return { id, write: toBase64Url(write), read: toBase64Url(read), key: new Uint8Array(key) as Uint8Array<ArrayBuffer> };
    }

    const payload = buildPayload({ v: 1, phone: 'Pixel 7', updated: 0, services: [] });
    const blob = (v: { id: string; key: Uint8Array<ArrayBuffer> }, version: number) =>
      sealVault(v.key, fromBase64Url(v.id), version, payload);

    it('creates a vault once per id and checks the request', async () => {
      const v = await vault();
      const again = await call('POST', '/v1/vaults', { json: { id: v.id, write: hash(token32()), read: hash(token32()) } });
      assert.deepEqual(again.json, { error: 'exists' });
      assert.equal((await call('POST', '/v1/vaults', { json: { id: v.id } })).status, 400);
      assert.equal((await call('POST', '/v1/vaults', { json: { id: 'x', write: hash(token32()), read: hash(token32()) } })).status, 400);
      assert.equal((await call('POST', '/v1/vaults', { body: new Uint8Array([1, 2]) })).status, 400);
    });

    it('stores higher versions only, and says when the browser last read it', async () => {
      const v = await vault();
      assert.deepEqual((await call('GET', `/v1/vault/${v.id}`, { token: v.read })).json, { error: 'empty' });
      assert.equal((await call('PUT', `/v1/vault/${v.id}`, { token: v.read, body: await blob(v, 1) })).status, 401);
      assert.deepEqual((await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: await blob(v, 1) })).json, {
        version: 1,
        last_read: null,
      });
      assert.deepEqual((await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: await blob(v, 1) })).json, {
        error: 'stale_version',
        version: 1,
      });

      const download = await call('GET', `/v1/vault/${v.id}`, { token: v.read });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('etag'), '"1"');
      assert.equal(download.headers.get('content-type'), 'application/octet-stream');
      assert.equal(download.raw.length, 40 + PAD_BLOCK);

      clock += DAY;
      assert.deepEqual((await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: await blob(v, 5) })).json, {
        version: 5,
        last_read: '2026-10-13',
      });
    });

    it('answers 304 when the browser already has the version', async () => {
      const v = await vault();
      await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: await blob(v, 2) });
      const r = await call('GET', `/v1/vault/${v.id}`, { token: v.read, headers: { 'If-None-Match': '"2"' } });
      assert.equal(r.status, 304);
      assert.equal(r.raw.length, 0);
      assert.equal((await call('GET', `/v1/vault/${v.id}`, { token: v.read, headers: { 'If-None-Match': '"1"' } })).status, 200);
      assert.equal((await call('GET', `/v1/vault/${v.id}`, { token: v.write })).status, 401);
    });

    it('refuses blobs of the wrong shape or size', async () => {
      const v = await vault();
      assert.deepEqual((await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: randomBytes(40 + PAD_BLOCK) })).json, {
        error: 'bad_request',
      });
      assert.equal((await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: randomBytes(100) })).status, 400);
      assert.deepEqual(
        (await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: new Uint8Array(MAX_BLOB_LENGTH + PAD_BLOCK) })).json,
        { error: 'too_large' },
      );
    });

    it('deletes a vault for either token and remembers it as gone', async () => {
      const v = await vault();
      await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: await blob(v, 1) });
      assert.equal((await call('DELETE', `/v1/vault/${v.id}`, { token: toBase64Url(token32()) })).status, 401);
      assert.equal((await call('DELETE', `/v1/vault/${v.id}`, { token: v.read })).status, 204);
      assert.deepEqual((await call('GET', `/v1/vault/${v.id}`, { token: v.read })).json, { error: 'gone' });
      assert.deepEqual((await call('PUT', `/v1/vault/${v.id}`, { token: v.write, body: await blob(v, 2) })).json, { error: 'gone' });
      assert.equal((await call('DELETE', `/v1/vault/${v.id}`, { token: v.write })).status, 410);
      assert.deepEqual(
        (await call('POST', '/v1/vaults', { json: { id: v.id, write: hash(token32()), read: hash(token32()) } })).json,
        { error: 'exists' },
      );
      assert.equal((await call('GET', `/v1/vault/${id16()}`, { token: v.read })).status, 404);
    });

    it('keeps only token hashes', async () => {
      const v = await vault();
      const stored = store.getVault(v.id)!;
      assert.equal(toBase64Url(stored.writeHash), hash(Buffer.from(v.write, 'base64url')));
      assert.notEqual(toBase64Url(stored.writeHash), v.write);
    });

    it('deletes vaults never read within 7 days, or not read for 180', async () => {
      const unread = await vault();
      await call('PUT', `/v1/vault/${unread.id}`, { token: unread.write, body: await blob(unread, 1) });
      const read = await vault();
      await call('PUT', `/v1/vault/${read.id}`, { token: read.write, body: await blob(read, 1) });
      await call('GET', `/v1/vault/${read.id}`, { token: read.read });

      clock += 7 * DAY;
      relay.housekeeping();
      assert.deepEqual((await call('GET', `/v1/vault/${unread.id}`, { token: unread.read })).json, { error: 'gone' });
      assert.equal((await call('GET', `/v1/vault/${read.id}`, { token: read.read })).status, 200);

      clock += 181 * DAY;
      relay.housekeeping();
      assert.deepEqual((await call('GET', `/v1/vault/${read.id}`, { token: read.read })).json, { error: 'gone' });
      clock += 181 * DAY;
      relay.housekeeping();
      assert.equal((await call('GET', `/v1/vault/${read.id}`, { token: read.read })).status, 404);
    });
  });

  describe('rate limits', () => {
    before(async () => {
      await stop();
      await start({ channels: 2, vaults: 1, downloads: 2, uploads: 1 });
    });
    after(async () => {
      await stop();
      await start();
    });

    it('limits channels and vaults per client address', async () => {
      assert.equal((await call('PUT', `/v1/pair/${id16()}`, { ip: '198.51.100.7' })).status, 201);
      assert.equal((await call('PUT', `/v1/pair/${id16()}`, { ip: '198.51.100.7' })).status, 201);
      const limited = await call('PUT', `/v1/pair/${id16()}`, { ip: '198.51.100.7' });
      assert.deepEqual(limited.json, { error: 'rate_limited' });
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await call('PUT', `/v1/pair/${id16()}`, { ip: '198.51.100.8' })).status, 201);
      clock += 60 * MINUTE;
      assert.equal((await call('PUT', `/v1/pair/${id16()}`, { ip: '198.51.100.7' })).status, 201);

      const make = () => call('POST', '/v1/vaults', { ip: '198.51.100.9', json: { id: id16(), write: hash(token32()), read: hash(token32()) } });
      assert.equal((await make()).status, 201);
      assert.equal((await make()).status, 429);
    });

    it('takes the address the proxy added, not ones the client put before it', async () => {
      const put = (ip: string) => call('PUT', `/v1/pair/${id16()}`, { ip });
      assert.equal((await put('192.0.2.1, 198.51.100.20')).status, 201);
      assert.equal((await put('192.0.2.2, 198.51.100.20')).status, 201);
      assert.equal((await put('192.0.2.3, 198.51.100.20')).status, 429);
    });
  });
});
