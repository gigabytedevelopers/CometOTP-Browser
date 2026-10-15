// The lock's cryptography (src/lock/crypto.ts), in Node with hash-wasm's WebAssembly Argon2id.
import assert from 'node:assert/strict';
import { createHash, hkdfSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { argon2id } from 'hash-wasm/dist/index.esm.js';

import { fromBase64Url, randomBytes, toBase64Url, utf8 } from '@cometotp/protocol';

import {
  KDF_DEFAULTS,
  createLock,
  isLockRecord,
  openLock,
  openPrivate,
  openWithPasskey,
  passkeyKey,
  passwordKey,
  prfSalt,
  relock,
  sealPrivate,
  wrapForPasskey,
  type KdfParams,
} from '../src/lock/crypto.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const salt16 = toBase64Url(Uint8Array.from({ length: 16 }, (_, i) => i));

describe('passwordKey', () => {
  it("reproduces the reference implementation's Argon2id test vector", async () => {
    // From the reference implementation's tests: "password", "somesalt", m = 64 MiB, t = 2, p = 1.
    const hash = await argon2id({ password: 'password', salt: 'somesalt', iterations: 2, parallelism: 1, memorySize: 65536, hashLength: 32, outputType: 'hex' });
    assert.equal(hash, '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
  });

  // The keys below were computed with Node's own Argon2id (OpenSSL), which reproduces RFC 9106's
  // test vector.
  it("derives the key with the extension's own settings", async () => {
    const kdf: KdfParams = { name: 'argon2id', salt: salt16, ...KDF_DEFAULTS };
    assert.deepEqual(KDF_DEFAULTS, { memory: 65536, passes: 3, parallelism: 1 });
    assert.equal(hex(await passwordKey('correct horse battery staple', kdf)), '0d1a3c6523c8f06e4e0af9c515aa5b5448cfebd6838f2d52c3d8b6ef8ddc3c2e');
  });

  it('normalizes the password, so the same text typed differently gives the same key', async () => {
    const kdf: KdfParams = { name: 'argon2id', salt: salt16, ...KDF_DEFAULTS };
    const composed = 'pässwörd 🔑';
    const decomposed = composed.normalize('NFD');
    assert.notEqual(composed, decomposed);
    const expected = '9d376399de4e14ac083b2326cae74dc5507fbb71efee3860f943797802890b2b';
    assert.equal(hex(await passwordKey(composed, kdf)), expected);
    assert.equal(hex(await passwordKey(decomposed, kdf)), expected);
  });
});

describe('the lock', () => {
  it('opens with its password and gives back the same local key', async () => {
    const { record, localKey } = await createLock('several unrelated words');
    assert.ok(isLockRecord(record));
    assert.equal(localKey.length, 32);
    assert.deepEqual(await openLock(record, 'several unrelated words'), localKey);
  });

  it('stays shut for a wrong password, and for a record that was changed', async () => {
    const { record } = await createLock('several unrelated words');
    assert.equal(await openLock(record, 'several unrelated word'), null);
    const sealed = fromBase64Url(record.password.sealed);
    sealed[0]! ^= 1;
    assert.equal(await openLock({ ...record, password: { ...record.password, sealed: toBase64Url(sealed) } }, 'several unrelated words'), null);
    assert.equal(await openLock({ ...record, kdf: { ...record.kdf, passes: 2 } }, 'several unrelated words'), null);
  });

  it('keeps nothing in its record that gives away the key or the password', async () => {
    const { record, localKey } = await createLock('several unrelated words');
    const text = JSON.stringify(record);
    assert.ok(!text.includes(toBase64Url(localKey)));
    assert.ok(!text.includes('several'));
    assert.deepEqual(Object.keys(record).sort(), ['kdf', 'password', 'v']);
  });

  it('takes a new password around the same local key, and keeps the passkey able to unlock', async () => {
    const { record, localKey } = await createLock('several unrelated words');
    const prf = randomBytes(32);
    const withPasskey = { ...record, passkey: await wrapForPasskey(localKey, 'credential', prf) };
    const changed = await relock(withPasskey, localKey, 'other unrelated words');
    assert.notEqual(changed.kdf.salt, record.kdf.salt);
    assert.deepEqual(await openLock(changed, 'other unrelated words'), localKey);
    assert.equal(await openLock(changed, 'several unrelated words'), null);
    assert.deepEqual(changed.passkey, withPasskey.passkey);
    assert.deepEqual(await openWithPasskey(changed.passkey!, prf), localKey);
  });

  it('refuses records it does not know', () => {
    for (const value of [null, {}, { v: 2 }, { v: 1, kdf: { name: 'scrypt' } }, 'lock']) {
      assert.equal(isLockRecord(value), false);
    }
  });
});

describe('private values', () => {
  it('open only with the local key and the name they were sealed under', async () => {
    const localKey = randomBytes(32);
    const value = utf8('the vault key');
    const sealed = await sealPrivate(localKey, 'vault', value);
    assert.deepEqual(await openPrivate(localKey, 'vault', sealed), value);
    await assert.rejects(openPrivate(randomBytes(32), 'vault', sealed));
    await assert.rejects(openPrivate(localKey, 'links', sealed));
  });
});

describe('passkeys', () => {
  it('ask every passkey for its PRF output on SHA256("CometOTP unlock v1 prf")', async () => {
    assert.equal(hex(await prfSalt()), createHash('sha256').update('CometOTP unlock v1 prf').digest('hex'));
  });

  it('turn the PRF output into a key with HKDF, as protocol §8 says', async () => {
    const prf = randomBytes(32);
    const expected = Buffer.from(hkdfSync('sha256', prf, Buffer.alloc(0), 'CometOTP unlock v1 passkey', 32));
    assert.equal(hex(await passkeyKey(prf)), expected.toString('hex'));
    await assert.rejects(async () => passkeyKey(randomBytes(16)), /32 bytes/);
  });

  it('open their copy of the local key only with the same PRF output', async () => {
    const { record, localKey } = await createLock('several unrelated words');
    const prf = randomBytes(32);
    const wrap = await wrapForPasskey(localKey, 'credential-id', prf);
    assert.equal(wrap.credential, 'credential-id');
    assert.deepEqual(await openWithPasskey(wrap, prf), localKey);
    assert.equal(await openWithPasskey(wrap, randomBytes(32)), null);
    assert.ok(!JSON.stringify(wrap).includes(toBase64Url(localKey)));

    // A record with a passkey is still a record; a malformed passkey makes it none.
    assert.ok(isLockRecord({ ...record, passkey: wrap }));
    assert.equal(isLockRecord({ ...record, passkey: { credential: 1 } }), false);
    // The password's copy is unaffected.
    assert.deepEqual(await openLock({ ...record, passkey: wrap }, 'several unrelated words'), localKey);
  });
});
