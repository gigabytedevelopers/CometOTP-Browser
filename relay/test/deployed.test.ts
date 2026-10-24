// Against a relay that is already running, such as the Docker image behind its proxy
// (docs/self-hosting.md): set RELAY_URL to its base URL. Skipped otherwise, as in `npm test`.
// The phone's and the browser's requests, with real pairing frames and a real vault, go through
// whatever stands in front of the relay, so a proxy that cuts long polls short or changes a
// header fails here.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TO_BROWSER,
  TO_PHONE,
  buildPayload,
  derivePairingKeys,
  ecdh,
  fromBase32,
  fromBase64Url,
  generateKeyPair,
  helloPhonePublicKey,
  openPairingFrame,
  openVault,
  pairingTranscript,
  randomBytes,
  sealPairingFrame,
  sealVault,
  serviceId,
  sha256,
  toBase64Url,
  type Bytes,
  type PairingCode,
} from '@cometotp/protocol';

const RELAY_URL = process.env.RELAY_URL;

interface Options {
  token?: string | Bytes;
  json?: unknown;
  body?: Bytes;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, options: Options = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) {
    const token = typeof options.token === 'string' ? options.token : toBase64Url(options.token);
    headers.Authorization = `Bearer ${token}`;
  }
  let body: string | Bytes | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.body) {
    headers['Content-Type'] = 'application/octet-stream';
    body = options.body;
  }
  const response = await fetch(RELAY_URL + path, { method, headers, body });
  const raw = new Uint8Array(await response.arrayBuffer());
  const isJson = (response.headers.get('content-type') ?? '').startsWith('application/json');
  const json: any = isJson ? JSON.parse(Buffer.from(raw).toString('utf8')) : undefined;
  return { status: response.status, headers: response.headers, raw, json };
}

/** The frame of the first message waiting after `after`, from a pairing channel read. */
async function nextFrame(channel: string, direction: 'to-browser' | 'to-phone', token: string, after: number) {
  const r = await call('GET', `/v1/pair/${channel}/${direction}?after=${after}`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.messages[0].seq, after + 1);
  return fromBase64Url(r.json.messages[0].m as string);
}

describe('a deployed relay', { skip: RELAY_URL ? false : 'RELAY_URL is not set' }, () => {
  it('says which protocol it speaks, with CORS and no caching', async () => {
    const r = await call('GET', '/v1/');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { protocol: 1 });
    // After a deployment, RELAY_VERSION says which version should be running.
    if (process.env.RELAY_VERSION) assert.equal(r.headers.get('x-relay-version'), process.env.RELAY_VERSION);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('access-control-expose-headers'), 'Date, ETag, Retry-After');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  it('pairs a phone with a browser', async () => {
    // The browser makes its code and channel.
    const browser = await generateKeyPair();
    const code: PairingCode = {
      relay: RELAY_URL!,
      channel: randomBytes(16),
      browserPublicKey: browser.publicKey,
      secret: randomBytes(32),
      browserName: 'Deployed test',
    };
    const channel = toBase64Url(code.channel);
    const created = await call('PUT', `/v1/pair/${channel}`);
    assert.equal(created.status, 201);
    const browserToken = created.json.token as string;

    // The phone answers with the hello, which claims the channel.
    const phone = await generateKeyPair();
    const phoneKeys = await derivePairingKeys(
      await ecdh(phone.privateKey, code.browserPublicKey),
      code.secret,
      await pairingTranscript(code, phone.publicKey),
    );
    const hello = await sealPairingFrame(phoneKeys, code.channel, TO_BROWSER, 1, { t: 'hello', phone: 'Deployed phone' }, phone.publicKey);
    const claim = await call('POST', `/v1/pair/${channel}/to-browser`, { json: { m: toBase64Url(hello) } });
    assert.equal(claim.status, 201);
    assert.equal(claim.json.seq, 1);
    const phoneToken = claim.json.token as string;

    // The browser opens it and shows the same six digits, then confirms.
    const received = await nextFrame(channel, 'to-browser', browserToken, 0);
    const phoneKey = helloPhonePublicKey(received);
    const browserKeys = await derivePairingKeys(
      await ecdh(browser.privateKey, phoneKey),
      code.secret,
      await pairingTranscript(code, phoneKey),
    );
    assert.deepEqual(await openPairingFrame(browserKeys, code.channel, TO_BROWSER, 1, received), { t: 'hello', phone: 'Deployed phone' });
    assert.equal(browserKeys.sas, phoneKeys.sas);
    const confirm = await sealPairingFrame(browserKeys, code.channel, TO_PHONE, 1, { t: 'confirm' });
    assert.equal((await call('POST', `/v1/pair/${channel}/to-phone`, { token: browserToken, json: { m: toBase64Url(confirm) } })).status, 201);

    const answer = await nextFrame(channel, 'to-phone', phoneToken, 0);
    assert.deepEqual(await openPairingFrame(phoneKeys, code.channel, TO_PHONE, 1, answer), { t: 'confirm' });

    // Done: the phone deletes the channel, and it is gone for both.
    assert.equal((await call('DELETE', `/v1/pair/${channel}`, { token: phoneToken })).status, 204);
    assert.deepEqual((await call('GET', `/v1/pair/${channel}/to-browser?after=1`, { token: browserToken })).json, { error: 'expired' });
  });

  it('keeps, serves and deletes a vault', async () => {
    const id = randomBytes(16);
    const vault = toBase64Url(id);
    const write = randomBytes(32);
    const read = randomBytes(32);
    const key = randomBytes(32);
    const created = await call('POST', '/v1/vaults', {
      json: { id: vault, write: toBase64Url(await sha256(write)), read: toBase64Url(await sha256(read)) },
    });
    assert.equal(created.status, 201);
    assert.deepEqual((await call('GET', `/v1/vault/${vault}`, { token: read })).json, { error: 'empty' });

    const secret = fromBase32('JBSWY3DPEHPK3PXP');
    const json = buildPayload({
      v: 1,
      phone: 'Deployed phone',
      updated: Math.floor(Date.now() / 1000),
      services: [{ id: await serviceId(secret), type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: 'GitHub', label: 'alice' }],
    });
    const blob = await sealVault(key, id, 1, json);
    const stored = await call('PUT', `/v1/vault/${vault}`, { token: write, body: blob });
    assert.equal(stored.status, 200);
    assert.deepEqual(stored.json, { version: 1, last_read: null });

    const downloaded = await call('GET', `/v1/vault/${vault}`, { token: read });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('etag'), '"1"');
    assert.deepEqual(await openVault(key, id, downloaded.raw), { version: 1, json });
    assert.equal((await call('GET', `/v1/vault/${vault}`, { token: read, headers: { 'If-None-Match': '"1"' } })).status, 304);

    assert.equal((await call('DELETE', `/v1/vault/${vault}`, { token: write })).status, 204);
    assert.deepEqual((await call('GET', `/v1/vault/${vault}`, { token: read })).json, { error: 'gone' });
  });

  it('holds a long poll open for its whole wait', { timeout: 60_000 }, async () => {
    const channel = toBase64Url(randomBytes(16));
    const created = await call('PUT', `/v1/pair/${channel}`);
    assert.equal(created.status, 201);
    const started = Date.now();
    const r = await call('GET', `/v1/pair/${channel}/to-browser?after=0`, { token: created.json.token as string });
    const waited = Date.now() - started;
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { messages: [] });
    // The relay waits 25 seconds by default; a proxy that gives up sooner answers with an error.
    assert.ok(waited >= 20_000, `answered after ${waited} ms`);
    assert.equal((await call('DELETE', `/v1/pair/${channel}`, { token: created.json.token as string })).status, 204);
  });
});
