// The two manifests: the same extension, differing only where Chromium and Firefox do.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXTENSION_PAGES_CSP, GECKO_ID, MAX_DESCRIPTION, TARGETS, manifest } from '../tools/manifest.js';

describe('manifest', () => {
  const chromium = manifest('chromium', '1.2.3');
  const firefox = manifest('firefox', '1.2.3');

  it('is the same extension in both browsers, apart from the background and browser settings', () => {
    const { background: _cb, minimum_chrome_version: _min, ...chromiumRest } = chromium;
    const { background: _fb, browser_specific_settings: _bss, ...firefoxRest } = firefox;
    assert.deepEqual(chromiumRest, firefoxRest);
    for (const target of TARGETS) {
      const m = manifest(target, '1.2.3');
      assert.equal(m.manifest_version, 3);
      assert.equal(m.version, '1.2.3');
      assert.equal(m.name, 'CometOTP');
      assert.ok((m.description as string).length <= MAX_DESCRIPTION);
    }
  });

  it('runs the background as a module service worker in Chromium and as module scripts in Firefox', () => {
    assert.deepEqual(chromium.background, { service_worker: 'background.js', type: 'module' });
    assert.deepEqual(firefox.background, { scripts: ['background.js'], type: 'module' });
  });

  it('gives Firefox a fixed id and says no data is collected', () => {
    assert.deepEqual(firefox.browser_specific_settings, {
      gecko: { id: GECKO_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } },
    });
  });

  it('asks only for alarms, idle and storage, and keeps the strict content security policy', () => {
    for (const m of [chromium, firefox]) {
      assert.deepEqual(m.permissions, ['alarms', 'idle', 'storage']);
      for (const key of ['optional_permissions', 'host_permissions', 'optional_host_permissions']) {
        assert.equal(key in m, false, key);
      }
      assert.deepEqual(m.content_security_policy, { extension_pages: EXTENSION_PAGES_CSP });
    }
    // Scripts only from the extension itself; WebAssembly for Argon2id, never eval of JavaScript.
    assert.equal(EXTENSION_PAGES_CSP, "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'");
  });
});
