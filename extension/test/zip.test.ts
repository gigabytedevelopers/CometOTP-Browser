// The zip writer, read back with a reader written here from the format's description.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { zip, type ZipEntry } from '../tools/zip.js';
import { unzip } from './unzip.js';

const entries: ZipEntry[] = [
  { path: 'manifest.json', data: Buffer.from('{"name":"CometOTP"}\n') },
  { path: 'popup/popup.js', data: Buffer.from('console.log("x");\n'.repeat(50)) },
  { path: 'icons/icon-16.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  { path: 'empty.txt', data: Buffer.alloc(0) },
];

describe('zip', () => {
  it('holds every file exactly, stored as it is', () => {
    const archive = zip(entries);
    const files = unzip(archive);
    assert.deepEqual([...files.keys()], ['empty.txt', 'icons/icon-16.png', 'manifest.json', 'popup/popup.js']);
    for (const entry of entries) assert.deepEqual(files.get(entry.path), Buffer.from(entry.data));
    for (const entry of entries) assert.ok(archive.includes(Buffer.from(entry.data)), entry.path);
  });

  it('gives the same bytes for the same files, whatever their order', () => {
    assert.deepEqual(zip(entries), zip([...entries].reverse()));
  });

  it('gives these very bytes on any machine, as nothing in it depends on the Node it runs on', () => {
    const digest = createHash('sha256').update(zip(entries)).digest('hex');
    assert.equal(digest, '31083a0318f55adca6d2bf85ec522a3da29b2d11c58f8299a1e2feafb3b5b95c');
  });

  it('refuses paths that leave the archive', () => {
    for (const path of ['/etc/passwd', '../x.js', 'a/../../b', 'a\\b.js']) {
      assert.throws(() => zip([{ path, data: Buffer.alloc(1) }]), /Not a relative path/);
    }
  });
});
