// The protocol's rules that the vectors do not pin down: strict encodings, URI and relay checks,
// message checks, the vault's version and padding rules, and skipping bad services.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOB_OVERHEAD,
  MAX_BLOB_LENGTH,
  PAD_BLOCK,
  TO_BROWSER,
  TO_PHONE,
  blobVersion,
  buildPayload,
  checkRelayUrl,
  derivePairingKeys,
  fromBase32,
  fromBase64Url,
  generateKeyPair,
  ecdh,
  formatPairingUri,
  isP256Point,
  openPairingFrame,
  openVault,
  parsePairingUri,
  parsePayload,
  randomBytes,
  sealPairingFrame,
  sealVault,
  secondsLeft,
  toBase32,
  toBase64Url,
  ProtocolError,
  type PairingCode,
  type Payload,
  type ProtocolErrorCode,
} from '../src/index.js';

const fails = (code: ProtocolErrorCode) => (error: unknown) => error instanceof ProtocolError && error.code === code;

describe('encodings', () => {
  it('round-trips base64url and base32 at every length', () => {
    for (let length = 0; length <= 40; length++) {
      const bytes = randomBytes(length);
      assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
      assert.deepEqual(fromBase32(toBase32(bytes)), bytes);
    }
  });

  it('refuses padding, other alphabets and impossible lengths', () => {
    for (const text of ['AA==', 'AA+/', 'A', 'AA AA']) assert.throws(() => fromBase64Url(text), fails('bad_encoding'));
    for (const text of ['JBSWY3DP=', 'jbswy3dp', 'JBSWY3DP1', 'A', 'ABC']) {
      assert.throws(() => fromBase32(text), fails('bad_encoding'));
    }
  });
});

async function newCode(): Promise<PairingCode> {
  return {
    relay: 'https://relay.example.com/sync',
    channel: randomBytes(16),
    browserPublicKey: (await generateKeyPair()).publicKey,
    secret: randomBytes(32),
    browserName: 'Firefox on Linux — ünïcode',
  };
}

describe('pairing codes', () => {
  it('round-trips a code with a path in the relay and a non-ASCII name', async () => {
    const code = await newCode();
    assert.deepEqual(parsePairingUri(formatPairingUri(code)), code);
  });

  it('refuses other versions with their own error', async () => {
    const uri = formatPairingUri(await newCode()).replace('v=1', 'v=2');
    assert.throws(() => parsePairingUri(uri), fails('unsupported_version'));
  });

  it('refuses other schemes and wrong lengths', async () => {
    const uri = formatPairingUri(await newCode());
    assert.throws(() => parsePairingUri(uri.replace('cometotp://', 'otpauth://')), fails('bad_uri'));
    assert.throws(() => parsePairingUri(uri.replace(/&c=[^&]+/, '&c=AAAA')), fails('bad_uri'));
    assert.throws(() => parsePairingUri(uri.replace(/&n=[^&]+/, '&n=')), fails('bad_uri'));
    assert.throws(() => parsePairingUri(uri.replace(/&n=[^&]+/, `&n=${'x'.repeat(65)}`)), fails('bad_uri'));
  });

  it('only accepts https relays, or local http when allowed', () => {
    assert.equal(checkRelayUrl('https://relay.example.com'), 'https://relay.example.com');
    for (const relay of [
      'http://relay.example.com',
      'https://relay.example.com/',
      'https://relay.example.com?x=1',
      'https://relay.example.com#x',
      'https://user:pass@relay.example.com',
      'ftp://relay.example.com',
      'not a url',
    ]) {
      assert.throws(() => checkRelayUrl(relay), fails('bad_relay'), relay);
    }
    assert.throws(() => checkRelayUrl('http://192.168.1.20:8080'), fails('bad_relay'));
    assert.equal(checkRelayUrl('http://192.168.1.20:8080', { allowInsecure: true }), 'http://192.168.1.20:8080');
    assert.equal(checkRelayUrl('http://localhost:8080', { allowInsecure: true }), 'http://localhost:8080');
    assert.throws(() => checkRelayUrl('http://relay.example.com', { allowInsecure: true }), fails('bad_relay'));
    assert.equal(checkRelayUrl('http://[fd12:3456::1]:8080', { allowInsecure: true }), 'http://[fd12:3456::1]:8080');
    assert.equal(checkRelayUrl('http://[::1]:8080', { allowInsecure: true }), 'http://[::1]:8080');
    // Names that only look like local addresses can be pointed anywhere.
    for (const name of ['10.relay.example.net', '127.evil.com', '192.168.1.1.nip.example', 'fd00.example.com']) {
      assert.throws(() => checkRelayUrl(`http://${name}`, { allowInsecure: true }), fails('bad_relay'));
    }
  });
});

describe('pairing messages', () => {
  async function keys() {
    const browser = await generateKeyPair();
    const phone = await generateKeyPair();
    const shared = await ecdh(phone.privateKey, browser.publicKey);
    assert.deepEqual(await ecdh(browser.privateKey, phone.publicKey), shared);
    return { keys: await derivePairingKeys(shared, randomBytes(32), randomBytes(32)), phone };
  }

  it('runs a whole exchange with fresh keys', async () => {
    const { keys: k, phone } = await keys();
    const channel = randomBytes(16);
    const hello = await sealPairingFrame(k, channel, TO_BROWSER, 1, { t: 'hello', phone: 'Pixel 7' }, phone.publicKey);
    assert.deepEqual(await openPairingFrame(k, channel, TO_BROWSER, 1, hello), { t: 'hello', phone: 'Pixel 7' });
    const confirm = await sealPairingFrame(k, channel, TO_PHONE, 1, { t: 'confirm' });
    assert.deepEqual(await openPairingFrame(k, channel, TO_PHONE, 1, confirm), { t: 'confirm' });
    const vault = { t: 'vault', id: toBase64Url(randomBytes(16)), read: toBase64Url(randomBytes(32)), key: toBase64Url(randomBytes(32)) } as const;
    const sealed = await sealPairingFrame(k, channel, TO_BROWSER, 2, vault);
    assert.deepEqual(await openPairingFrame(k, channel, TO_BROWSER, 2, sealed), vault);
    await assert.rejects(openPairingFrame(k, randomBytes(16), TO_BROWSER, 2, sealed), fails('auth_failed'));
  });

  it('refuses a vault message with a short key, and unknown messages', async () => {
    const { keys: k } = await keys();
    const channel = randomBytes(16);
    const shortKey = { t: 'vault', id: toBase64Url(randomBytes(16)), read: toBase64Url(randomBytes(32)), key: 'AAAA' } as const;
    const sealed = await sealPairingFrame(k, channel, TO_BROWSER, 2, shortKey);
    await assert.rejects(openPairingFrame(k, channel, TO_BROWSER, 2, sealed), fails('bad_encoding'));
  });

  it('puts the phone key on the hello and nowhere else', async () => {
    const { keys: k, phone } = await keys();
    const channel = randomBytes(16);
    await assert.rejects(sealPairingFrame(k, channel, TO_BROWSER, 1, { t: 'hello', phone: 'x' }), RangeError);
    await assert.rejects(sealPairingFrame(k, channel, TO_PHONE, 1, { t: 'confirm' }, phone.publicKey), RangeError);
  });

  it('checks points on the curve', async () => {
    const { publicKey } = await generateKeyPair();
    assert.ok(isP256Point(publicKey));
    const off = publicKey.slice();
    off[64] = off[64]! ^ 1;
    assert.ok(!isP256Point(off));
    assert.ok(!isP256Point(publicKey.subarray(0, 33)));
  });
});

const payload: Payload = {
  v: 1,
  phone: 'Galaxy S25 Ultra',
  updated: 1791763200,
  services: [
    {
      id: 'AAAAAAAAAAAAAAAA',
      type: 'totp',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      issuer: 'Example',
      label: 'alice',
    },
  ],
};

describe('vault rules', () => {
  it('pads to whole blocks and refuses other lengths and versions', async () => {
    const key = randomBytes(32);
    const id = randomBytes(16);
    const blob = await sealVault(key, id, 7, buildPayload(payload));
    assert.equal(blob.length, BLOB_OVERHEAD + PAD_BLOCK);
    assert.equal(blobVersion(blob), 7);
    assert.throws(() => blobVersion(blob.subarray(0, blob.length - 1)), fails('bad_blob'));
    const wrongMagic = blob.slice();
    wrongMagic[0] = 0x58;
    assert.throws(() => blobVersion(wrongMagic), fails('bad_blob'));
    assert.throws(() => blobVersion(new Uint8Array(MAX_BLOB_LENGTH + PAD_BLOCK)), fails('bad_blob'));
    const big = { ...payload, phone: 'x', services: Array.from({ length: 40 }, () => payload.services[0]!) };
    assert.equal((await sealVault(key, id, 1, buildPayload(big))).length, BLOB_OVERHEAD + 2 * PAD_BLOCK);
  });

  it('refuses a rollback and accepts the same version again', async () => {
    const key = randomBytes(32);
    const id = randomBytes(16);
    const blob = await sealVault(key, id, 4, buildPayload(payload));
    await assert.rejects(openVault(key, id, blob, { minVersion: 5 }), fails('rollback'));
    assert.equal((await openVault(key, id, blob, { minVersion: 4 })).version, 4);
  });

  it('refuses a blob sealed for another vault', async () => {
    const key = randomBytes(32);
    const blob = await sealVault(key, randomBytes(16), 1, buildPayload(payload));
    await assert.rejects(openVault(key, randomBytes(16), blob), fails('auth_failed'));
  });

  it('skips bad and unknown services but keeps the rest', () => {
    const good = payload.services[0]!;
    const json = JSON.stringify({
      ...payload,
      extra: 'ignored',
      services: [
        good,
        { ...good, id: 'BBBBBBBBBBBBBBBB', type: 'hotp' },
        { ...good, id: 'CCCCCCCCCCCCCCCC', digits: 11 },
        { ...good, id: 'DDDDDDDDDDDDDDDD', secret: 'not base32' },
        { ...good, id: 'EEEEEEEEEEEEEEEE', badge: 'red' },
        { ...good, id: 'FFFFFFFFFFFFFFFF', initials: 'ABC' },
        { ...good },
        { ...good, id: 'GGGGGGGGGGGGGGGG', tags: ['Work'], icon: 'Github', badge: '#3F51B5', unknown: true },
      ],
    });
    const { payload: read, skipped } = parsePayload(json);
    assert.deepEqual(read.services.map((s) => s.id), ['AAAAAAAAAAAAAAAA', 'GGGGGGGGGGGGGGGG']);
    assert.equal(skipped, 6);
  });

  it('asks for a newer extension on a newer payload version', () => {
    assert.throws(() => parsePayload(JSON.stringify({ ...payload, v: 2 })), fails('unsupported_version'));
    assert.throws(() => parsePayload('{"v":1}'), fails('bad_payload'));
    assert.throws(() => parsePayload('[]'), fails('bad_payload'));
  });
});

describe('time', () => {
  it('counts the seconds left in a period', () => {
    assert.equal(secondsLeft(30, 1791763200), 30);
    assert.equal(secondsLeft(30, 1791763229.9), 1);
  });
});
