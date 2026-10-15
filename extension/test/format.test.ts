// How the popup writes services and codes (src/popup/format.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { badgeColor, groupCode, initials, matches, skewText, updatedText } from '../src/popup/format.js';

describe('popup formatting', () => {
  it('groups codes as CometOTP does, and leaves Steam codes whole', () => {
    assert.equal(groupCode('123456'), '123 456');
    assert.equal(groupCode('12345678'), '1234 5678');
    assert.equal(groupCode('1234567'), '123 4567');
    assert.equal(groupCode('1234'), '1234');
    assert.equal(groupCode('2B4FX', 'steam'), '2B4FX');
  });

  it('says how long ago the phone sent its copy', () => {
    const now = 1_791_763_200_000;
    const seconds = now / 1000;
    assert.equal(updatedText(seconds - 20, now), 'Updated just now');
    assert.equal(updatedText(seconds - 60, now), 'Updated 1 minute ago');
    assert.equal(updatedText(seconds - 5 * 60, now), 'Updated 5 minutes ago');
    assert.equal(updatedText(seconds - 2 * 3600, now), 'Updated 2 hours ago');
    assert.equal(updatedText(seconds - 3 * 86400, now), 'Updated 3 days ago');
    assert.equal(updatedText(seconds + 60, now), 'Updated just now');
  });

  it('makes initials from the person’s choice, or the issuer, or the label', () => {
    assert.equal(initials({ initials: 'Zq', issuer: 'GitHub', label: '' }), 'Zq');
    assert.equal(initials({ issuer: 'GitHub', label: 'alice' }), 'GI');
    assert.equal(initials({ issuer: 'Microsoft Azure', label: '' }), 'MA');
    assert.equal(initials({ issuer: '', label: 'bob@example.com' }), 'BE');
    assert.equal(initials({ issuer: '', label: '' }), '?');
  });

  it('keeps the person’s badge colour, and otherwise picks the same one for the same service', () => {
    assert.equal(badgeColor({ badge: '#123456', id: 'x' }), '#123456');
    assert.equal(badgeColor({ id: 'AAAAAAAAAAAAAAAA' }), badgeColor({ id: 'AAAAAAAAAAAAAAAA' }));
    assert.match(badgeColor({ id: 'BBBBBBBBBBBBBBBB' }), /^#[0-9a-f]{6}$/);
  });

  it('searches the issuer, label and tags, ignoring case and accents', () => {
    const service = { issuer: 'Société Générale', label: 'alice@example.com', tags: ['Work'] };
    assert.ok(matches(service, 'societe'));
    assert.ok(matches(service, 'ALICE'));
    assert.ok(matches(service, 'work'));
    assert.ok(matches(service, '  '));
    assert.ok(!matches(service, 'github'));
  });

  it('says how far off the clock is', () => {
    assert.equal(skewText(45_000), '45 seconds');
    assert.equal(skewText(-90_000), '90 seconds');
    assert.equal(skewText(300_000), '5 minutes');
  });
});
