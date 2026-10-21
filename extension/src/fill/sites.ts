// Which sites codes may be filled on, and which services to offer there (design §4, Filling):
// services linked to the site first, then those whose issuer names it. A service linked to other
// sites is offered only on those, so a page elsewhere cannot have it listed; the person can still
// search for it, and is asked first. A name proves nothing about a site, as "GitHub" names
// github.top as well as github.com, so a service's first fill on any site is asked about too
// (src/fill/menu.ts). Nothing here touches a page (test/sites.test.ts).

/**
 * The sites the content script may run on, once the person allows it: https, and http on this
 * computer for testing. tools/manifest.ts asks for them as optional host permissions.
 */
export const FILL_SITES: readonly string[] = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];

/** For each service id, the hosts it was filled on. */
export type Links = Record<string, string[]>;

/**
 * The host of a page codes may be filled on, without "www.": https only, so no one on the
 * network can stand in for a site, and http on this computer, for testing.
 */
export function siteHost(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return null;
  return parsed.hostname.replace(/^www\./, '');
}

/** Whether `inner` is `outer` or one of its subdomains. */
export function within(inner: string, outer: string): boolean {
  return inner === outer || inner.endsWith(`.${outer}`);
}

/**
 * Whether a frame on host `frame` may be filled on a page from host `top`: one host within the
 * other. That is narrower than being the same site, which needs the public suffix list, and keeps
 * codes out of frames from elsewhere.
 */
export function sameSite(frame: string, top: string): boolean {
  if (top === 'localhost' || top === '127.0.0.1') return frame === top;
  return within(frame, top) || within(top, frame);
}

/** Labels of a host that name nothing in particular. */
const GENERIC_LABELS = new Set(['www', 'com', 'co', 'org', 'net', 'gov', 'edu', 'ac']);

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Whether an issuer names a host: "GitHub" names github.com, "Amazon Web Services" names
 * signin.aws.amazon.com (its first word), and "example.com" names example.com and its subdomains.
 * Only the site's own name counts, the label before the domain ending, and only whole: "GitHub"
 * names neither github.evil.com nor github-login.example.
 */
export function issuerNames(issuer: string, host: string): boolean {
  const name = fold(issuer).trim();
  if (!name) return false;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(name)) return within(host, name);
  const parts = name.split(/[^a-z0-9]+/).filter(Boolean);
  if (!parts.length) return false;
  const compact = parts.join('');
  const label = host
    .split('.')
    .slice(0, -1)
    .filter((part) => !GENERIC_LABELS.has(part))
    .pop();
  return label !== undefined && (label === compact || (parts.length > 1 && label === parts[0]));
}

/** What the menu offers on a host, each in the vault's order. */
export interface Offer<S> {
  /** Services filled on this host (or a host it is within) before. */
  linked: S[];
  /** Services linked nowhere, whose issuer names this host. */
  matching: S[];
  /** The rest, found by searching. */
  others: S[];
}

export function offer<S extends { id: string; issuer: string }>(services: S[], links: Links, host: string): Offer<S> {
  const result: Offer<S> = { linked: [], matching: [], others: [] };
  for (const service of services) {
    const hosts = links[service.id] ?? [];
    if (hosts.some((linked) => within(host, linked))) result.linked.push(service);
    else if (!hosts.length && issuerNames(service.issuer, host)) result.matching.push(service);
    else result.others.push(service);
  }
  return result;
}

/** The hosts a service is linked to, if it is linked elsewhere and not to this host. */
export function linkedElsewhere(service: { id: string }, links: Links, host: string): string[] {
  const hosts = links[service.id] ?? [];
  return hosts.some((linked) => within(host, linked)) ? [] : hosts;
}
