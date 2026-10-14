// The built packages (npm test builds first): what each one holds, that its zip holds the same,
// that the check finds nothing, and that it would find what it is there to catch.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { checkPackage } from '../tools/check.js';
import { TARGETS, manifest } from '../tools/manifest.js';
import { listFiles, rewriteImports, targetDir, version, zipPath } from '../tools/package.js';
import { unzip } from './unzip.js';

const EXPECTED = [
  'background.js',
  'icons/icon-128.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'lib/hash-wasm/LICENSE',
  'lib/hash-wasm/index.esm.js',
  'lib/protocol/codes.js',
  'lib/protocol/crypto.js',
  'lib/protocol/encoding.js',
  'lib/protocol/errors.js',
  'lib/protocol/index.js',
  'lib/protocol/pairing.js',
  'lib/protocol/vault.js',
  'lock/crypto.js',
  'lock/strength.js',
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

    it(`${target}: copies hash-wasm exactly as npm publishes it`, () => {
      const published = fileURLToPath(import.meta.resolve('hash-wasm/dist/index.esm.js'));
      assert.deepEqual(readFileSync(join(targetDir(target), 'lib/hash-wasm/index.esm.js')), readFileSync(published));
    });

    it(`${target}: its zip holds exactly the same files`, () => {
      const files = unzip(readFileSync(zipPath(target)));
      assert.deepEqual([...files.keys()], EXPECTED);
      for (const [path, data] of files) assert.deepEqual(data, readFileSync(join(targetDir(target), path)), path);
    });

    it(`${target}: passes the check`, () => {
      assert.deepEqual(checkPackage(target), []);
    });
  }
});

describe('the check', () => {
  const copies: string[] = [];
  after(() => copies.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** A copy of the Chromium package with one change made to it. */
  function changed(change: (dir: string) => void): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'cometotp-check-'));
    copies.push(dir);
    cpSync(targetDir('chromium'), dir, { recursive: true });
    change(dir);
    return checkPackage('chromium', dir);
  }

  const edit = (dir: string, path: string, replace: (text: string) => string) =>
    writeFileSync(join(dir, path), replace(readFileSync(join(dir, path), 'utf8')));

  it('refuses a permission nobody argued for, and a looser content security policy', () => {
    const problems = changed((dir) =>
      edit(dir, 'manifest.json', (text) => {
        const m = JSON.parse(text);
        m.host_permissions = ['<all_urls>'];
        m.content_security_policy.extension_pages = "script-src 'self' 'unsafe-eval'";
        return JSON.stringify(m);
      }),
    );
    assert.ok(problems.some((p) => p.includes('"<all_urls>"')));
    assert.ok(problems.some((p) => p.includes('content security policy')));
  });

  it('refuses inline scripts, handlers and anything loaded from elsewhere', () => {
    const problems = changed((dir) =>
      edit(dir, 'popup/popup.html', (html) =>
        html.replace('</main>', '<script>alert(1)</script><a onclick="x()" href="https://example.com">x</a></main>'),
      ),
    );
    assert.ok(problems.some((p) => p.endsWith('inline script')));
    assert.ok(problems.some((p) => p.endsWith('inline event handler')));
    assert.ok(problems.some((p) => p.endsWith('loads something from elsewhere')));
  });

  it('refuses eval, HTML injection and imports the browser cannot resolve', () => {
    const problems = changed((dir) =>
      edit(dir, 'popup/popup.js', (js) => `${js}\neval("1");\ndocument.body.innerHTML = "x";\nimport('@cometotp/protocol');\nimport('./missing.js');\n`),
    );
    for (const expected of ['calls eval', 'injects HTML', 'which the browser cannot resolve', 'which is not in the package']) {
      assert.ok(problems.some((p) => p.includes(expected)), expected);
    }
  });

  it('refuses files that should not ship, and a missing file the manifest names', () => {
    const problems = changed((dir) => {
      writeFileSync(join(dir, 'popup/popup.ts'), '');
      rmSync(join(dir, 'icons/icon-16.png'));
    });
    assert.ok(problems.some((p) => p.includes('popup/popup.ts: not a file')));
    assert.ok(problems.some((p) => p.includes('names icons/icon-16.png, which is missing')));
  });
});

describe('rewriteImports', () => {
  it('points hash-wasm at its copy', () => {
    assert.equal(
      rewriteImports("import { argon2id } from 'hash-wasm/dist/index.esm.js';", 'lock/crypto.js'),
      "import { argon2id } from '../lib/hash-wasm/index.esm.js';",
    );
  });

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
