// What the settings page's list of sites shows (src/settings/site-list.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIRST_SITES, findSites, firstSites, siteCount, siteServices, withoutSite, type SiteService } from '../src/settings/site-list.js';

const github = { id: 'S1', issuer: 'GitHub', label: 'alice', tags: ['work'] };
const bank = { id: 'S2', issuer: 'Société Générale', label: 'alice' };
const mail = { id: 'S3', issuer: 'Mail', label: 'bob' };

const list: SiteService[] = [
  { service: github, filled: ['github.com', 'gist.github.com'], hidden: ['github.io'] },
  { service: bank, filled: ['particuliers.sg.fr'], hidden: [] },
];

/** The sites a list shows, as "service: site". */
const sites = (shown: SiteService[]) => shown.flatMap((entry) => [...entry.filled, ...entry.hidden].map((site) => `${entry.service.id}: ${site}`));

describe('the list of sites', () => {
  it('has the services with sites, in the vault order', () => {
    const shown = siteServices([mail, bank, github], { S1: ['github.com'], S2: ['particuliers.sg.fr'] }, { S1: ['github.io'] });
    assert.deepEqual(
      shown.map((entry) => entry.service.id),
      ['S2', 'S1'],
    );
    assert.deepEqual(shown[1], { service: github, filled: ['github.com'], hidden: ['github.io'] });
    assert.equal(siteCount(shown), 3);
  });

  it('finds a service by its name or tags, ignoring case and accents, with all its sites', () => {
    assert.deepEqual(sites(findSites(list, 'societe')), ['S2: particuliers.sg.fr']);
    assert.deepEqual(sites(findSites(list, ' WORK ')), ['S1: github.com', 'S1: gist.github.com', 'S1: github.io']);
  });

  it('finds the sites whose address has the words, without the rest of their service', () => {
    assert.deepEqual(sites(findSites(list, 'gist')), ['S1: gist.github.com']);
    assert.deepEqual(sites(findSites(list, '.io')), ['S1: github.io']);
    assert.deepEqual(findSites(list, 'nowhere'), []);
  });

  it('has everything for an empty search', () => {
    assert.deepEqual(findSites(list, '  '), list);
  });

  it('shows the first sites only, across services', () => {
    assert.deepEqual(sites(firstSites(list, 2)), ['S1: github.com', 'S1: gist.github.com']);
    assert.deepEqual(sites(firstSites(list, 3)), ['S1: github.com', 'S1: gist.github.com', 'S1: github.io']);
    assert.deepEqual(sites(firstSites(list, 4)), sites(list));
    assert.deepEqual(firstSites(list, 0), []);
    const long = [{ service: github, filled: Array.from({ length: 1000 }, (_, i) => `site-${i}.example`), hidden: [] }];
    assert.equal(siteCount(firstSites(long, FIRST_SITES)), FIRST_SITES);
  });

  it('forgets a site, and a service once it has none', () => {
    assert.deepEqual(sites(withoutSite(list, 'S1', 'filled', 'github.com')), ['S1: gist.github.com', 'S1: github.io', 'S2: particuliers.sg.fr']);
    assert.deepEqual(sites(withoutSite(list, 'S1', 'filled', 'github.io')), sites(list), 'only among sites of its kind');
    assert.deepEqual(sites(withoutSite(list, 'S2', 'filled', 'particuliers.sg.fr')), ['S1: github.com', 'S1: gist.github.com', 'S1: github.io']);
  });
});
