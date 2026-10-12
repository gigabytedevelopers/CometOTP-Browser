// Reproduces every value in vectors/v1.json and refuses every `reject` entry (protocol §11).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  TO_BROWSER,
  TO_PHONE,
  derivePairingKeys,
  deriveBlobKey,
  ecdh,
  formatPairingUri,
  fromBase32,
  fromBase64Url,
  fromHex,
  generateCode,
  helloPhonePublicKey,
  hkdf,
  importPublicKey,
  openPairingFrame,
  openVault,
  pairingAad,
  pairingTranscript,
  parsePairingUri,
  parsePayload,
  sealPairingFrame,
  sealVault,
  serviceId,
  sha256,
  toBase64Url,
  toHex,
  utf8,
  concat,
  ProtocolError,
  type Algorithm,
  type Bytes,
  type PairingKeys,
  type PairingMessage,
  type ServiceType,
} from '../src/index.js';

interface Message {
  direction: 'to-browser' | 'to-phone';
  index: number;
  nonce: string;
  aad: string;
  plaintext: string;
  frame: string;
}

interface Vectors {
  protocol: number;
  pairing: {
    relay: string;
    browser_name: string;
    phone_name: string;
    browser_private: string;
    phone_private: string;
    browser_public: string;
    phone_public: string;
    secret: string;
    channel: string;
    uri: string;
    shared: string;
    transcript: string;
    okm: string;
    key_to_browser: string;
    key_to_phone: string;
    sas: string;
    messages: Message[];
  };
  vault: {
    id: string;
    write_token: string;
    write_hash: string;
    read_token: string;
    read_hash: string;
    key: string;
    blob_key: string;
    version: number;
    payload: string;
    padded_length: number;
    nonce: string;
    blob: string;
  };
  service_ids: { secret: string; id: string }[];
  codes: {
    type: ServiceType;
    secret: string;
    algorithm: Algorithm;
    digits: number;
    period: number;
    time: number;
    code: string;
  }[];
  reject: (
    | { what: string; kind: 'frame'; direction: Message['direction']; index: number; hasPhoneKey: boolean; frame: string }
    | { what: string; kind: 'blob'; blob: string }
    | { what: string; kind: 'public_key'; key: string }
  )[];
}

const vectors = JSON.parse(
  await readFile(new URL('../../../../vectors/v1.json', import.meta.url), 'utf8'),
) as Vectors;
const { pairing, vault } = vectors;

/** WebCrypto cannot import a bare P-256 scalar, so the test keys go in as JWK. */
async function privateKey(scalarHex: string, publicKey: Bytes): Promise<CryptoKey> {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: toBase64Url(fromHex(scalarHex)),
    x: toBase64Url(publicKey.subarray(1, 33)),
    y: toBase64Url(publicKey.subarray(33, 65)),
  };
  return globalThis.crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

const direction = (name: Message['direction']) => (name === 'to-browser' ? TO_BROWSER : TO_PHONE);

async function pairingKeys(): Promise<PairingKeys> {
  const code = parsePairingUri(pairing.uri);
  const phonePublic = fromBase64Url(pairing.phone_public);
  const shared = await ecdh(await privateKey(pairing.phone_private, phonePublic), code.browserPublicKey);
  return derivePairingKeys(shared, code.secret, await pairingTranscript(code, phonePublic));
}

describe('pairing vectors', () => {
  it('formats and parses the QR code', () => {
    const code = parsePairingUri(pairing.uri);
    assert.equal(code.relay, pairing.relay);
    assert.equal(code.browserName, pairing.browser_name);
    assert.equal(toBase64Url(code.channel), pairing.channel);
    assert.equal(toBase64Url(code.browserPublicKey), pairing.browser_public);
    assert.equal(toBase64Url(code.secret), pairing.secret);
    assert.equal(formatPairingUri(code), pairing.uri);
  });

  it('reaches the same shared secret from both sides, leading zero kept', async () => {
    const browserPublic = fromBase64Url(pairing.browser_public);
    const phonePublic = fromBase64Url(pairing.phone_public);
    const fromPhone = await ecdh(await privateKey(pairing.phone_private, phonePublic), browserPublic);
    const fromBrowser = await ecdh(await privateKey(pairing.browser_private, browserPublic), phonePublic);
    assert.equal(toHex(fromPhone), pairing.shared);
    assert.equal(toHex(fromBrowser), pairing.shared);
    assert.equal(fromPhone.length, 32);
  });

  it('derives the transcript, keys and SAS', async () => {
    const code = parsePairingUri(pairing.uri);
    const transcript = await pairingTranscript(code, fromBase64Url(pairing.phone_public));
    assert.equal(toHex(transcript), pairing.transcript);
    const okm = await hkdf(concat(fromHex(pairing.shared), code.secret), transcript, utf8('CometOTP pair v1 keys'), 68);
    assert.equal(toHex(okm), pairing.okm);
    const keys = await pairingKeys();
    assert.equal(toBase64Url(keys.toBrowser), pairing.key_to_browser);
    assert.equal(toBase64Url(keys.toPhone), pairing.key_to_phone);
    assert.equal(keys.sas, pairing.sas);
  });

  it('opens and reseals every message byte for byte', async () => {
    const keys = await pairingKeys();
    const channel = fromBase64Url(pairing.channel);
    const phonePublic = fromBase64Url(pairing.phone_public);
    for (const m of pairing.messages) {
      const dir = direction(m.direction);
      const frame = fromBase64Url(m.frame);
      assert.equal(toHex(pairingAad(channel, dir, m.index)), m.aad);
      const isHello = dir === TO_BROWSER && m.index === 1;
      if (isHello) assert.deepEqual(helloPhonePublicKey(frame), phonePublic);
      const message = await openPairingFrame(keys, channel, dir, m.index, frame);
      assert.deepEqual(message, JSON.parse(m.plaintext) as PairingMessage);
      const resealed = await sealPairingFrame(keys, channel, dir, m.index, message, isHello ? phonePublic : undefined, {
        nonce: fromBase64Url(m.nonce),
      });
      assert.equal(toBase64Url(resealed), m.frame);
    }
  });
});

describe('vault vectors', () => {
  it('hashes the tokens', async () => {
    assert.equal(toBase64Url(await sha256(fromBase64Url(vault.write_token))), vault.write_hash);
    assert.equal(toBase64Url(await sha256(fromBase64Url(vault.read_token))), vault.read_hash);
  });

  it('derives the blob key, seals the payload byte for byte and opens it', async () => {
    const id = fromBase64Url(vault.id);
    const key = fromBase64Url(vault.key);
    assert.equal(toBase64Url(await deriveBlobKey(key, id)), vault.blob_key);
    const blob = await sealVault(key, id, vault.version, vault.payload, { nonce: fromBase64Url(vault.nonce) });
    assert.equal(toBase64Url(blob), vault.blob);
    assert.equal(blob.length - 40, vault.padded_length);
    assert.deepEqual(await openVault(key, id, blob), { version: vault.version, json: vault.payload });
  });

  it('reads the payload and checks its service ids', async () => {
    const { payload, skipped } = parsePayload(vault.payload);
    assert.equal(skipped, 0);
    assert.equal(payload.services.length, 2);
    for (const service of payload.services) assert.equal(await serviceId(fromBase32(service.secret)), service.id);
  });

  it('computes the listed service ids', async () => {
    for (const v of vectors.service_ids) assert.equal(await serviceId(fromBase32(v.secret)), v.id);
  });
});

describe('code vectors', () => {
  it('computes all codes', async () => {
    for (const v of vectors.codes) assert.equal(await generateCode(v, v.time), v.code, JSON.stringify(v));
  });
});

describe('rejected vectors', () => {
  for (const v of vectors.reject) {
    it(`refuses: ${v.what}`, async () => {
      if (v.kind === 'frame') {
        const keys = await pairingKeys();
        const channel = fromBase64Url(pairing.channel);
        await assert.rejects(
          openPairingFrame(keys, channel, direction(v.direction), v.index, fromBase64Url(v.frame)),
          (error) => error instanceof ProtocolError && error.code === 'auth_failed',
        );
      } else if (v.kind === 'blob') {
        await assert.rejects(
          openVault(fromBase64Url(vault.key), fromBase64Url(vault.id), fromBase64Url(v.blob)),
          (error) => error instanceof ProtocolError && error.code === 'auth_failed',
        );
      } else {
        await assert.rejects(
          importPublicKey(fromBase64Url(v.key)),
          (error) => error instanceof ProtocolError && error.code === 'bad_public_key',
        );
      }
    });
  }
});
