// Which sites each service was filled on, so the menu offers it there first, and the sites the
// person took it off, where its name would otherwise offer it (design §4). Sealed under the local
// key M like everything private: the sites someone signs in to are theirs. Both go with the
// pairing: forgetPairing deletes them.
//
// The background and any page may change them at once: filling a code in one tab while removing a
// site on the settings page, or removing two sites in quick succession. Each change reads both,
// opens them and writes them back, so changes take turns under one lock, which the background and
// the pages share (Web Locks); otherwise one could write back what another had just removed.
import { fromUtf8, utf8, type Bytes } from '@cometotp/protocol';

import { openPrivate, sealPrivate, type Sealed } from '../lock/crypto.js';
import { getRecord, putRecord } from '../lock/storage.js';
import { forgetHost, linkToSite, removeFromSite, type Links } from './sites.js';

export const LINKS = 'site-links';
export const HIDDEN = 'site-hidden';

/** The Web Lock every change to the links or the hidden sites holds. */
const LOCK = 'cometotp-site-links';

/** Runs `change` once no other change to the links or hidden sites is under way, here or elsewhere. */
function exclusively(change: () => Promise<void>): Promise<void> {
  return navigator.locks.request(LOCK, change);
}

async function read(localKey: Bytes, name: string): Promise<Links> {
  const sealed = (await getRecord(name)) as Sealed | undefined;
  if (!sealed) return {};
  return JSON.parse(fromUtf8(await openPrivate(localKey, name, sealed))) as Links;
}

async function write(localKey: Bytes, name: string, links: Links): Promise<void> {
  await putRecord(name, await sealPrivate(localKey, name, utf8(JSON.stringify(links))));
}

export function readLinks(localKey: Bytes): Promise<Links> {
  return read(localKey, LINKS);
}

export function readHidden(localKey: Bytes): Promise<Links> {
  return read(localKey, HIDDEN);
}

/** Writes `next` where it differs from what was read. */
async function update(localKey: Bytes, before: { links: Links; hidden: Links }, next: { links: Links; hidden: Links }): Promise<void> {
  if (JSON.stringify(next.links) !== JSON.stringify(before.links)) await write(localKey, LINKS, next.links);
  if (JSON.stringify(next.hidden) !== JSON.stringify(before.hidden)) await write(localKey, HIDDEN, next.hidden);
}

/** Links `service` to `host`, unless it already is, and stops hiding it there. */
export function addLink(localKey: Bytes, service: string, host: string): Promise<void> {
  return exclusively(async () => {
    const before = { links: await readLinks(localKey), hidden: await readHidden(localKey) };
    await update(localKey, before, linkToSite({ id: service }, before.links, before.hidden, host));
  });
}

/** Takes `service` off what the menu offers on `host` (src/fill/sites.ts, removeFromSite). */
export function removeLink(localKey: Bytes, service: { id: string; issuer: string }, host: string): Promise<void> {
  return exclusively(async () => {
    const before = { links: await readLinks(localKey), hidden: await readHidden(localKey) };
    await update(localKey, before, removeFromSite(service, before.links, before.hidden, host));
  });
}

/** Forgets that `service` was filled on `host`, from the settings page. */
export function forgetLink(localKey: Bytes, service: string, host: string): Promise<void> {
  return exclusively(async () => {
    const links = await readLinks(localKey);
    const next = forgetHost(links, service, host);
    if (next[service]?.length !== links[service]?.length) await write(localKey, LINKS, next);
  });
}

/** Stops hiding `service` on `host`, from the settings page, so its name offers it there again. */
export function unhide(localKey: Bytes, service: string, host: string): Promise<void> {
  return exclusively(async () => {
    const hidden = await readHidden(localKey);
    const next = forgetHost(hidden, service, host);
    if (next[service]?.length !== hidden[service]?.length) await write(localKey, HIDDEN, next);
  });
}
