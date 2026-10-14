// The built packages (npm test builds first): what each one holds, and that its zip holds the same.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { TARGETS, manifest } from '../tools/manifest.js';
import { listFiles, rewriteImports, targetDir, version, zipPath } from '../tools/package.js';
import { unzip } from './unzip.js';

const EXPECTED = [
  'background.js',
  'icons/icon-128.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'manifest.json',
  'messages.js',
  'popup/popup.css',
  'popup/popup.html',
  'popup/popup.js',
];

describe('the built packages', () => {
  for (const target of TARGETS) {
    it(`${target}: holds the compiled scripts, the pages and icons, and its manifest`, () => {
      const dir = targetDir(target);
      assert.deepEqual(listFiles(dir), EXPECTED);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), manifest(target, version()));
    });

    it(`${target}: its zip holds exactly the same files`, () => {
      const files = unzip(readFileSync(zipPath(target)));
      assert.deepEqual([...files.keys()], EXPECTED);
      for (const [path, data] of files) assert.deepEqual(data, readFileSync(join(targetDir(target), path)), path);
    });
  }
});

describe('rewriteImports', () => {
  it('points the protocol package at its copy, relative to each file', () => {
    assert.equal(
      rewriteImports("import { zip } from '@cometotp/protocol';", 'background.js'),
      "import { zip } from './lib/protocol/index.js';",
    );
    assert.equal(
      rewriteImports('import { a } from "@cometotp/protocol";\nconst m = await import("@cometotp/protocol");', 'popup/popup.js'),
      'import { a } from "../lib/protocol/index.js";\nconst m = await import("../lib/protocol/index.js");',
    );
  });

  it('leaves everything else alone', () => {
    const source = "import { isPing } from './messages.js';\nconst s = '@cometotp/protocol is a package';";
    assert.equal(rewriteImports(source, 'background.js'), source);
  });
});
