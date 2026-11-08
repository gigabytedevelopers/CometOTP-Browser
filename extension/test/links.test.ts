// The sites each service was filled on or taken off (src/fill/links.ts), over the stand-in storage
// (./fake-browser.ts). The background and the settings page change them, maybe at once.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { randomBytes, type Bytes } from '@cometotp/protocol';

import { addLink, forgetLink, readHidden, readLinks, removeLink, unhide } from '../src/fill/links.js';
import { installBrowser } from './fake-browser.js';

let localKey: Bytes;

beforeEach(() => {
  installBrowser();
  localKey = randomBytes(32);
});

describe('site links', () => {
  it('forgets both of two sites removed at once', async () => {
    await addLink(localKey, 'S1', 'a.example');
    await addLink(localKey, 'S1', 'b.example');
    await Promise.all([forgetLink(localKey, 'S1', 'a.example'), forgetLink(localKey, 'S1', 'b.example')]);
    assert.deepEqual(await readLinks(localKey), {});
  });

  it('keeps a site filled on while another is removed', async () => {
    await addLink(localKey, 'S1', 'a.example');
    await Promise.all([addLink(localKey, 'S2', 'c.example'), forgetLink(localKey, 'S1', 'a.example')]);
    assert.deepEqual(await readLinks(localKey), { S2: ['c.example'] });
  });

  it('offers again both of two sites at once', async () => {
    const github = { id: 'S1', issuer: 'GitHub' };
    await removeLink(localKey, github, 'github.com');
    await removeLink(localKey, github, 'github.io');
    assert.deepEqual(await readHidden(localKey), { S1: ['github.com', 'github.io'] });
    await Promise.all([unhide(localKey, 'S1', 'github.com'), unhide(localKey, 'S1', 'github.io')]);
    assert.deepEqual(await readHidden(localKey), {});
  });
});
