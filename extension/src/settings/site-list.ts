// What the settings page's list of sites shows (src/settings/settings.ts): each service with the
// sites it was filled on and those it was taken off, in the vault's order. A search finds a service
// by its name or tags, with all its sites, or the sites whose address has the words. A long list
// shows its first sites only, until the person asks for all of them. Nothing here touches the page
// (test/site-list.test.ts).
import type { Service } from '@cometotp/protocol';

import type { Links } from '../fill/sites.js';
import { matches } from '../popup/format.js';

/** Filled on a site, where the menu offers it first; or taken off one, where its name no longer offers it. */
export type SiteKind = 'filled' | 'hidden';

/** A service with sites, as the list shows it. */
export interface SiteService {
  service: Pick<Service, 'id' | 'issuer' | 'label' | 'tags'>;
  filled: string[];
  hidden: string[];
}

/** How many sites the list shows before a button shows the rest. */
export const FIRST_SITES = 20;

/** The services of the vault that have sites, with them. */
export function siteServices(services: readonly SiteService['service'][], links: Links, hidden: Links): SiteService[] {
  return services
    .map((service) => ({ service, filled: links[service.id] ?? [], hidden: hidden[service.id] ?? [] }))
    .filter((entry) => entry.filled.length + entry.hidden.length > 0);
}

export function siteCount(list: readonly SiteService[]): number {
  return list.reduce((count, entry) => count + entry.filled.length + entry.hidden.length, 0);
}

/**
 * What `query` finds: each service whose name or tags have it (ignoring case and accents), with
 * all its sites, and of the other services the sites whose address has it. Everything when empty.
 */
export function findSites(list: readonly SiteService[], query: string): SiteService[] {
  const host = query.trim().toLowerCase();
  if (!host) return [...list];
  return list.flatMap((entry) => {
    if (matches(entry.service, query)) return [entry];
    const has = (site: string) => site.includes(host);
    const found = { ...entry, filled: entry.filled.filter(has), hidden: entry.hidden.filter(has) };
    return found.filled.length + found.hidden.length ? [found] : [];
  });
}

/** The first `limit` sites of `list`, with their services. */
export function firstSites(list: readonly SiteService[], limit: number): SiteService[] {
  const shown: SiteService[] = [];
  let left = limit;
  for (const entry of list) {
    if (left <= 0) break;
    const filled = entry.filled.slice(0, left);
    const hidden = entry.hidden.slice(0, left - filled.length);
    left -= filled.length + hidden.length;
    shown.push({ ...entry, filled, hidden });
  }
  return shown;
}

/** `list` without `site` among the `kind` sites of service `id`, and without the service once it has none. */
export function withoutSite(list: readonly SiteService[], id: string, kind: SiteKind, site: string): SiteService[] {
  return list.flatMap((entry) => {
    if (entry.service.id !== id) return [entry];
    const next = { ...entry, [kind]: entry[kind].filter((other) => other !== site) };
    return next.filled.length + next.hidden.length ? [next] : [];
  });
}
