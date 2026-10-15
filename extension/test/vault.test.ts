// Whether a downloaded vault may replace the browser's copy (src/sync/vault.ts, protocol §7.2).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPayload, randomBytes, sealVault, type Payload } from '@cometotp/protocol';

import { assess } from '../src/sync/vault.js';

const key = randomBytes(32);
const id = randomBytes(16);
const payload: Payload = {
  v: 1,
  phone: 'Pixel 7',
  updated: 1_791_763_200,
  services: [
    { id: 'AAAAAAAAAAAAAAAA', type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: 'GitHub', label: 'alice' },
  ],
};
const vault = (version: number, json = buildPayload(payload), k = key) => sealVault(k, id, version, json);

describe('assess', () => {
  it('accepts a newer version that opens and reads', async () => {
    const result = await assess(await vault(3), 2, key, id);
    assert.equal(result.kind, 'accept');
    assert.ok(result.kind === 'accept' && result.version === 3 && result.payload.services[0]!.issuer === 'GitHub');
    assert.equal((await assess(await vault(1), 0, key, id)).kind, 'accept');
  });

  it('keeps the copy for the same version, and refuses an older one as a rollback', async () => {
    assert.deepEqual(await assess(await vault(2), 2, key, id), { kind: 'same', version: 2 });
    assert.deepEqual(await assess(await vault(1), 2, key, id), { kind: 'rollback', version: 1 });
  });

  it('refuses what is not a vault, or does not open with the key', async () => {
    assert.deepEqual(await assess(randomBytes(4136), 0, key, id), { kind: 'bad' });
    assert.deepEqual(await assess(await vault(3, undefined, randomBytes(32)), 2, key, id), { kind: 'bad' });
    const tampered = await vault(3);
    tampered[100]! ^= 1;
    assert.deepEqual(await assess(tampered, 2, key, id), { kind: 'bad' });
    assert.deepEqual(await assess(await vault(3, '{"v":1}'), 2, key, id), { kind: 'bad' });
  });

  it('says when the payload needs a newer extension', async () => {
    const newer = JSON.stringify({ ...payload, v: 2 });
    assert.deepEqual(await assess(await vault(3, newer), 2, key, id), { kind: 'newer-format' });
  });
});
