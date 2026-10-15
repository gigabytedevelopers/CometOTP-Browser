// Which sites codes may be filled on, and what the menu offers there (src/fill/sites.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { issuerNames, linkedElsewhere, offer, sameSite, siteHost } from '../src/fill/sites.js';

describe('siteHost', () => {
  it('takes https pages, and http only on this computer', () => {
    assert.equal(siteHost('https://www.github.com/sessions/two-factor'), 'github.com');
    assert.equal(siteHost('https://login.microsoftonline.com/common'), 'login.microsoftonline.com');
    assert.equal(siteHost('http://127.0.0.1:8080/fill.html'), '127.0.0.1');
    assert.equal(siteHost('http://localhost/'), 'localhost');
    assert.equal(siteHost('http://github.com/'), null);
    assert.equal(siteHost('file:///tmp/a.html'), null);
    assert.equal(siteHost('not a url'), null);
    assert.equal(siteHost(undefined), null);
  });
});

describe('sameSite', () => {
  it('lets a frame be filled when one host is within the other', () => {
    assert.ok(sameSite('github.com', 'github.com'));
    assert.ok(sameSite('auth.example.com', 'example.com'));
    assert.ok(sameSite('example.com', 'accounts.example.com'));
  });

  it('refuses frames from elsewhere, including look-alikes', () => {
    assert.ok(!sameSite('evil.com', 'github.com'));
    assert.ok(!sameSite('github.com.evil.com', 'github.com'));
    assert.ok(!sameSite('notgithub.com', 'github.com'));
    assert.ok(!sameSite('localhost', '127.0.0.1'));
  });
});

describe('issuerNames', () => {
  it('matches the site’s own name, whole', () => {
    assert.ok(issuerNames('GitHub', 'github.com'));
    assert.ok(issuerNames('Google', 'accounts.google.com'));
    assert.ok(issuerNames('Amazon Web Services', 'signin.aws.amazon.com'));
    assert.ok(issuerNames('BBC', 'account.bbc.co.uk'));
    assert.ok(issuerNames('Société Générale', 'societegenerale.fr'));
    assert.ok(issuerNames('example.com', 'login.example.com'));
  });

  it('does not match a look-alike, a subdomain, a part of a name, or the domain ending', () => {
    assert.ok(!issuerNames('GitHub', 'github-login.example'));
    assert.ok(!issuerNames('GitHub', 'github.evil.com'));
    assert.ok(!issuerNames('GitHub', 'github.com.evil.net'));
    assert.ok(!issuerNames('AWS', 'signin.aws.amazon.com'));
    assert.ok(!issuerNames('GitHub', 'githubb.com'));
    assert.ok(!issuerNames('Microsoft', 'login.microsoftonline.com'));
    assert.ok(!issuerNames('Com', 'example.com'));
    assert.ok(!issuerNames('example.com', 'example.com.evil.net'));
    assert.ok(!issuerNames('', 'github.com'));
  });
});

describe('offer', () => {
  const services = [
    { id: 'gh', issuer: 'GitHub' },
    { id: 'ms', issuer: 'Microsoft' },
    { id: 'gh2', issuer: 'GitHub' },
    { id: 'ex', issuer: 'Example' },
  ];

  it('offers services linked to the site, then those whose issuer names it, in the vault’s order', () => {
    const result = offer(services, { ms: ['login.microsoftonline.com'] }, 'login.microsoftonline.com');
    assert.deepEqual(result.linked.map((s) => s.id), ['ms']);
    assert.deepEqual(result.matching, []);
    const github = offer(services, { gh2: ['github.com'] }, 'gist.github.com');
    assert.deepEqual(github.linked.map((s) => s.id), ['gh2']);
    assert.deepEqual(github.matching.map((s) => s.id), ['gh']);
    assert.deepEqual(github.others.map((s) => s.id), ['ms', 'ex']);
  });

  it('keeps a service linked elsewhere out of the offer, where a search finds it with a warning', () => {
    const links = { gh: ['github.com'] };
    const phishing = offer(services, links, 'github.evil.com');
    assert.deepEqual(phishing.linked, []);
    assert.deepEqual(phishing.matching, []);
    assert.deepEqual(phishing.others.map((s) => s.id), ['gh', 'ms', 'gh2', 'ex']);
    // On a look-alike name, an unlinked service still matches by issuer; a linked one does not.
    const lookAlike = offer(services, links, 'github.co');
    assert.deepEqual(lookAlike.matching.map((s) => s.id), ['gh2']);
    assert.deepEqual(linkedElsewhere(services[0]!, links, 'github.evil.com'), ['github.com']);
    assert.deepEqual(linkedElsewhere(services[0]!, links, 'github.com'), []);
    assert.deepEqual(linkedElsewhere(services[1]!, links, 'github.com'), []);
  });
});
