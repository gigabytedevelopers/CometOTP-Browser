// Messages for filling, between the content script, the background and the menu page. Only the
// extension's own scripts can send them; each receiver also checks who sent one, from what the
// browser says about the sender.
import type { Service } from '@cometotp/protocol';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Content script → background: may this frame show the button? The answer is a boolean. */
export interface FillHere {
  type: 'fill-here';
}

/** Content script → background: open a menu for the focused field. The answer is FillOpened. */
export interface FillOpen {
  type: 'fill-open';
}

/** The menu's one-time name, or null when this frame may not be filled. */
export interface FillOpened {
  menu: string | null;
}

/** Menu page → background: which tab and frame it was opened for. The answer is a ClaimedMenu or null. */
export interface FillClaim {
  type: 'fill-claim';
  menu: string;
}

export interface ClaimedMenu {
  tabId: number;
  frameId: number;
  /** The page's host, without "www.". */
  host: string;
}

/** Menu page → background: what to list. The answer is a MenuList. */
export interface FillList {
  type: 'fill-list';
  menu: string;
}

/** A service as the menu shows it: names only, never a secret. */
export type MenuEntry = Pick<Service, 'id' | 'issuer' | 'label' | 'initials' | 'badge' | 'tags'> & {
  /** The other sites it is linked to, when it is not linked to this one. */
  elsewhere: string[];
};

export interface MenuList {
  /** "ready", or why there is nothing to list. */
  state: 'ready' | 'locked' | 'unpaired' | 'empty';
  linked: MenuEntry[];
  matching: MenuEntry[];
  others: MenuEntry[];
}

/** Menu page → background: fill the code of this service. The answer is a boolean. */
export interface FillChoose {
  type: 'fill-choose';
  menu: string;
  service: string;
}

/** Menu page → background → content script: how tall the menu is. */
export interface FillSize {
  type: 'fill-size';
  menu: string;
  height: number;
}

/** Background → content script: the code to fill into the field the menu was opened for. */
export interface FillCode {
  type: 'fill-code';
  menu: string;
  code: string;
}

/** Menu page → background → content script: close the menu. */
export interface FillClose {
  type: 'fill-close';
  menu: string;
}

export function isFillHere(value: unknown): value is FillHere {
  return isObject(value) && value.type === 'fill-here';
}

export function isFillOpen(value: unknown): value is FillOpen {
  return isObject(value) && value.type === 'fill-open';
}

export function isFillOpened(value: unknown): value is FillOpened {
  return isObject(value) && (value.menu === null || typeof value.menu === 'string');
}

export function isFillClaim(value: unknown): value is FillClaim {
  return isObject(value) && value.type === 'fill-claim' && typeof value.menu === 'string';
}

export function isClaimedMenu(value: unknown): value is ClaimedMenu {
  return isObject(value) && Number.isInteger(value.tabId) && Number.isInteger(value.frameId) && typeof value.host === 'string';
}

export function isFillList(value: unknown): value is FillList {
  return isObject(value) && value.type === 'fill-list' && typeof value.menu === 'string';
}

export function isMenuList(value: unknown): value is MenuList {
  return isObject(value) && typeof value.state === 'string' && Array.isArray(value.linked) && Array.isArray(value.matching) && Array.isArray(value.others);
}

export function isFillChoose(value: unknown): value is FillChoose {
  return isObject(value) && value.type === 'fill-choose' && typeof value.menu === 'string' && typeof value.service === 'string';
}

export function isFillSize(value: unknown): value is FillSize {
  return isObject(value) && value.type === 'fill-size' && typeof value.menu === 'string' && typeof value.height === 'number';
}

export function isFillCode(value: unknown): value is FillCode {
  return isObject(value) && value.type === 'fill-code' && typeof value.menu === 'string' && typeof value.code === 'string';
}

export function isFillClose(value: unknown): value is FillClose {
  return isObject(value) && value.type === 'fill-close' && typeof value.menu === 'string';
}
