// Which sites each service was filled on, so the menu offers it there first (design §4). Sealed
// under the local key M like everything private: the sites someone signs in to are theirs. Links
// go with the pairing: forgetPairing deletes them.
import { fromUtf8, utf8, type Bytes } from '@cometotp/protocol';

import { openPrivate, sealPrivate, type Sealed } from '../lock/crypto.js';
import { getRecord, putRecord } from '../lock/storage.js';
import type { Links } from './sites.js';

export const LINKS = 'site-links';

export async function readLinks(localKey: Bytes): Promise<Links> {
  const sealed = (await getRecord(LINKS)) as Sealed | undefined;
  if (!sealed) return {};
  return JSON.parse(fromUtf8(await openPrivate(localKey, LINKS, sealed))) as Links;
}

/** Links `service` to `host`, unless it already is. */
export async function addLink(localKey: Bytes, service: string, host: string): Promise<void> {
  const links = await readLinks(localKey);
  const hosts = links[service] ?? [];
  if (hosts.includes(host)) return;
  links[service] = [...hosts, host];
  await putRecord(LINKS, await sealPrivate(localKey, LINKS, utf8(JSON.stringify(links))));
}
