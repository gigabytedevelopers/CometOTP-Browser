// How the phone will show this browser.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { browserName } from '../src/pair/browser-name.js';

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

describe('browserName', () => {
  it('names the browser and the system from client hints', () => {
    const brands = (...names: string[]) => names.map((brand) => ({ brand }));
    assert.equal(browserName(MAC_CHROME, { brands: brands('Chromium', 'Google Chrome', 'Not A Brand'), platform: 'macOS' }), 'Chrome on macOS');
    assert.equal(browserName(MAC_CHROME, { brands: brands('Chromium', 'Microsoft Edge'), platform: 'Windows' }), 'Edge on Windows');
    assert.equal(browserName(MAC_CHROME, { brands: brands('Chromium', 'Brave'), platform: 'Linux' }), 'Brave on Linux');
    assert.equal(browserName(MAC_CHROME, { brands: brands('Chromium', 'Opera'), platform: 'Chrome OS' }), 'Opera on ChromeOS');
  });

  it('falls back on the user agent, as in Firefox', () => {
    assert.equal(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0'), 'Firefox on macOS');
    assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0'), 'Firefox on Windows');
    assert.equal(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0'), 'Firefox on Linux');
    assert.equal(browserName(MAC_CHROME), 'Chrome on macOS');
  });

  it('stays within the 64 bytes the protocol allows', () => {
    assert.ok(new TextEncoder().encode(browserName(MAC_CHROME, { brands: [{ brand: 'Microsoft Edge' }], platform: 'Windows' })).length <= 64);
  });
});
