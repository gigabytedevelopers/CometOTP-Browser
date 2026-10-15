// The background's part in filling. The content script asks it to open a menu; the menu page
// claims the menu, asks what to list, and says which service the person chose. The background
// then computes the code, links the service to the site and sends the code to the field's frame.
// It also passes on the menu's size and its closing: Firefox does not deliver messages from the
// menu page straight to the content script, and this way only the menu's own page can do either.
// So the menu page, in a frame on the site, holds names only, never the local key or a secret,
// and needs no storage of its own (Firefox partitions that of frames in other sites' pages).
//
// Every answer comes from what the browser says about the sender, never from anything a page
// could set: the frame's own address and its tab's. A menu's name is random and can be claimed
// once, by the extension's menu page in the same tab, so a page that embeds the menu page itself
// gets nothing.
import { generateCode, randomBytes, toBase64Url, type Service } from '@cometotp/protocol';

import { localKey } from '../lock/lock.js';
import { pairingRecord } from '../sync/store.js';
import { services } from '../sync/sync.js';
import { addLink, readLinks } from './links.js';
import type { ClaimedMenu, FillClose, FillCode, FillOpened, FillSize, MenuEntry, MenuList } from './messages.js';
import { linkedElsewhere, offer, sameSite, siteHost, type Links } from './sites.js';

/** A menu, kept in storage.session: the background may be stopped while it is open. */
interface Menu extends ClaimedMenu {
  at: number;
  claimed: boolean;
}

const MENUS = 'fill-menus';

/** How long a menu may take to load, and then stay open. */
const CLAIM_MS = 60_000;
const OPEN_MS = 15 * 60_000;

let queue: Promise<unknown> = Promise.resolve();

/** Runs `change` on the menus, one change at a time. */
function withMenus<T>(change: (menus: Record<string, Menu>) => T): Promise<T> {
  const next = queue.then(async () => {
    const stored = (await chrome.storage.session.get(MENUS))[MENUS];
    const menus = { ...((stored ?? {}) as Record<string, Menu>) };
    const now = Date.now();
    for (const [name, menu] of Object.entries(menus)) {
      if (now - menu.at > (menu.claimed ? OPEN_MS : CLAIM_MS)) delete menus[name];
    }
    const result = change(menus);
    await chrome.storage.session.set({ [MENUS]: menus });
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** The host to fill on, if the sender is a frame that may be: the top one or one of the same site. */
function fillHost(sender: chrome.runtime.MessageSender): string | null {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined) return null;
  const top = siteHost(sender.tab.url);
  const frame = siteHost(sender.url);
  if (!top || !frame) return null;
  return sender.frameId === 0 || sameSite(frame, top) ? top : null;
}

/** Whether the sender is the extension's menu page in this menu's tab. */
function fromMenuPage(menu: Menu, sender: chrome.runtime.MessageSender): boolean {
  const page = sender.url?.split('#')[0];
  return sender.id === chrome.runtime.id && page === chrome.runtime.getURL('fill/menu.html') && sender.tab?.id === menu.tabId;
}

export function mayFill(sender: chrome.runtime.MessageSender): boolean {
  return fillHost(sender) !== null;
}

export async function openMenu(sender: chrome.runtime.MessageSender): Promise<FillOpened> {
  const host = fillHost(sender);
  if (!host) return { menu: null };
  const name = toBase64Url(randomBytes(16));
  await withMenus((menus) => {
    menus[name] = { tabId: sender.tab!.id!, frameId: sender.frameId!, host, at: Date.now(), claimed: false };
  });
  return { menu: name };
}

export function claimMenu(name: string, sender: chrome.runtime.MessageSender): Promise<ClaimedMenu | null> {
  return withMenus((menus) => {
    const menu = menus[name];
    if (!menu || menu.claimed) return null;
    if (!fromMenuPage(menu, sender)) {
      delete menus[name];
      return null;
    }
    menus[name] = { ...menu, claimed: true, at: Date.now() };
    return { tabId: menu.tabId, frameId: menu.frameId, host: menu.host };
  });
}

/** The claimed menu `name`, if the sender is its page. */
function claimed(name: string, sender: chrome.runtime.MessageSender): Promise<Menu | null> {
  return withMenus((menus) => {
    const menu = menus[name];
    return menu?.claimed && fromMenuPage(menu, sender) ? menu : null;
  });
}

function entry(service: Service, links: Links, host: string): MenuEntry {
  const { id, issuer, label, initials, badge, tags } = service;
  return { id, issuer, label, initials, badge, tags, elsewhere: linkedElsewhere(service, links, host) };
}

export async function listMenu(name: string, sender: chrome.runtime.MessageSender): Promise<MenuList> {
  const nothing = (state: MenuList['state']): MenuList => ({ state, linked: [], matching: [], others: [] });
  const menu = await claimed(name, sender);
  const key = await localKey();
  if (!menu || !key) return nothing('locked');
  if (!(await pairingRecord())) return nothing('unpaired');
  const data = await services();
  if (!data?.payload.services.length) return nothing('empty');
  const links = await readLinks(key);
  const { linked, matching, others } = offer(data.payload.services, links, menu.host);
  const list = (some: Service[]) => some.map((service) => entry(service, links, menu.host));
  return { state: 'ready', linked: list(linked), matching: list(matching), others: list(others) };
}

/** Passes the menu's size or its closing on to the field's frame, if the sender is the menu's page. */
export async function passOn(note: FillSize | FillClose, sender: chrome.runtime.MessageSender): Promise<void> {
  const menu = await claimed(note.menu, sender);
  if (!menu) return;
  if (note.type === 'fill-close') {
    await withMenus((menus) => {
      delete menus[note.menu];
    });
  }
  await chrome.tabs.sendMessage(menu.tabId, note, { frameId: menu.frameId }).catch(() => undefined);
}

/** Fills the chosen service's code into the menu's field, and links the service to the site. */
export async function chooseService(name: string, id: string, sender: chrome.runtime.MessageSender): Promise<boolean> {
  const menu = await claimed(name, sender);
  const key = await localKey();
  const service = (await services())?.payload.services.find((s) => s.id === id);
  if (!menu || !key || !service) return false;
  const code = await generateCode(service, Date.now() / 1000);
  await addLink(key, service.id, menu.host);
  await withMenus((menus) => {
    delete menus[name];
  });
  const fill: FillCode = { type: 'fill-code', menu: name, code };
  await chrome.tabs.sendMessage(menu.tabId, fill, { frameId: menu.frameId });
  return true;
}
