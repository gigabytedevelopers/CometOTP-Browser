// The menu the CometOTP button in a code field opens: an extension page, in a frame the site
// cannot look into. It offers the services linked to the site, then those whose issuer names it,
// and lists the rest below, which the search narrows. It holds names only: the background computes
// the code of the service chosen, links it to the site and sends the code to the field
// (src/fill/menus.ts). A service not linked to this site yet is filled here only once the person
// confirms, as this site may be posing as the one it belongs to. A service offered here that does
// not belong can be taken off the site, and stays among the rest.
import { badgeColor, initials, matches } from '../popup/format.js';
import {
  isClaimedMenu,
  isMenuList,
  type ClaimedMenu,
  type FillChoose,
  type FillClaim,
  type FillClose,
  type FillForget,
  type FillList,
  type FillSize,
  type MenuEntry,
  type MenuList,
} from './messages.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const main = element('menu');
const site = element('site');
const message = element('message');
const choose = element('choose');
const offered = element<HTMLUListElement>('offered');
const none = element('none');
const removed = element('removed');
const search = element<HTMLInputElement>('search');
const othersTitle = element('others-title');
const found = element<HTMLUListElement>('found');
const noMatch = element('no-match');
const confirmPanel = element('confirm');
const confirmText = element('confirm-text');
const confirmFill = element<HTMLButtonElement>('confirm-fill');
const confirmCancel = element<HTMLButtonElement>('confirm-cancel');

const menu = location.hash.slice(1);

const STATES: Record<Exclude<MenuList['state'], 'ready'>, string> = {
  locked: 'CometOTP is locked. Unlock it from its button in the browser toolbar, then click the button in the field again.',
  unpaired: 'CometOTP is not paired with your phone yet. Pair it from its button in the browser toolbar.',
  empty: 'No services from your phone yet. In CometOTP, turn on Browser extension for the services you want here.',
};

/** Tells the field's frame something about the menu, through the background. */
function tell(note: FillSize | FillClose): Promise<unknown> {
  return chrome.runtime.sendMessage(note).catch(() => undefined);
}

function say(text: string): void {
  choose.hidden = true;
  confirmPanel.hidden = true;
  message.hidden = false;
  message.textContent = text;
}

function display(service: MenuEntry): string {
  return service.issuer && service.label ? `${service.issuer} (${service.label})` : service.issuer || service.label;
}

/** A service's row; with `remove`, a button that takes it off this site too. */
function row(service: MenuEntry, pick: (service: MenuEntry) => void, remove?: (service: MenuEntry) => void): HTMLLIElement {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'service';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = initials(service);
  badge.style.background = badgeColor(service);
  badge.setAttribute('aria-hidden', 'true');
  const names = document.createElement('span');
  names.className = 'names';
  const issuer = document.createElement('span');
  issuer.className = 'issuer';
  issuer.textContent = service.issuer || service.label;
  names.append(issuer);
  if (service.issuer && service.label) {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = service.label;
    names.append(label);
  }
  button.append(badge, names);
  button.setAttribute('aria-label', `Fill the code for ${display(service)}`);
  button.addEventListener('click', () => pick(service));
  item.append(button);
  if (remove) {
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'forget';
    forget.textContent = '\u00d7';
    forget.title = 'Not for this site';
    forget.setAttribute('aria-label', `Stop offering ${display(service)} here`);
    forget.addEventListener('click', () => remove(service));
    item.append(forget);
  }
  return item;
}

async function fill(service: MenuEntry): Promise<void> {
  const ask: FillChoose = { type: 'fill-choose', menu, service: service.id };
  // The field's frame closes this menu once it has the code.
  const done = await chrome.runtime.sendMessage(ask).catch(() => false);
  if (done !== true) say('The code could not be filled. Click the CometOTP button in the field again.');
}

function offerServices(claimed: ClaimedMenu, first: MenuList): void {
  let list = first;

  const pick = (service: MenuEntry) => {
    if (service.here) {
      void fill(service);
      return;
    }
    choose.hidden = true;
    confirmPanel.hidden = false;
    // The first fill on a site links the service to it, and a name that matches proves nothing:
    // anyone can register github.top. So the person checks the address before it is linked.
    confirmText.textContent = service.elsewhere.length
      ? `${display(service)} was filled on ${service.elsewhere.join(', ')} before, not on ${claimed.host}. ` +
        'A site can pose as another to get its code. Fill it here only if you trust this site.'
      : `${display(service)} has not been filled on any site yet. Check that ${claimed.host} is its real ` +
        'address: a site can pose as another to get its code. From then on it is offered here first.';
    confirmFill.textContent = service.elsewhere.length ? 'Fill anyway' : `Fill on ${claimed.host}`;
    confirmCancel.onclick = () => {
      confirmPanel.hidden = true;
      choose.hidden = false;
      search.focus();
    };
    confirmFill.onclick = () => void fill(service);
    confirmCancel.focus();
  };

  // A wrong fill links a service to a site it does not belong to, and a name can match a site it
  // has nothing to do with: either way the person takes it off here, and it joins the rest.
  const remove = async (service: MenuEntry) => {
    const ask: FillForget = { type: 'fill-forget', menu, service: service.id };
    const done = await chrome.runtime.sendMessage(ask).catch(() => false);
    const again: FillList = { type: 'fill-list', menu };
    const next = done === true ? await chrome.runtime.sendMessage(again).catch(() => null) : null;
    if (!isMenuList(next) || next.state !== 'ready') {
      say('The service could not be taken off this site. Click the CometOTP button in the field again.');
      return;
    }
    list = next;
    removed.hidden = false;
    removed.textContent = `${display(service)} is no longer offered on ${claimed.host}. To fill it here after all, choose it below.`;
    render();
    search.focus();
  };

  const render = () => {
    const query = search.value.trim();
    const shows = (service: MenuEntry) => !query || matches(service, query);
    const offeredHere = [...list.linked, ...list.matching];
    const shown = offeredHere.filter(shows);
    offered.replaceChildren(...shown.map((service) => row(service, pick, (s) => void remove(s))));
    none.hidden = offeredHere.length > 0 || query !== '';
    const rest = list.others.filter(shows);
    found.replaceChildren(...rest.map((service) => row(service, pick)));
    othersTitle.hidden = !rest.length;
    othersTitle.textContent = offeredHere.length ? 'Other services' : 'Your services';
    noMatch.hidden = !query || shown.length + rest.length > 0;
  };

  none.textContent = `No service is linked to ${claimed.host} yet. Choose it below; from then on it is offered here first.`;
  search.addEventListener('input', render);
  render();
  choose.hidden = false;
  if (list.linked.length + list.matching.length) offered.querySelector<HTMLButtonElement>('.service')?.focus();
  else search.focus();
}

async function start(): Promise<void> {
  const claim: FillClaim = { type: 'fill-claim', menu };
  const answer = menu ? await chrome.runtime.sendMessage(claim).catch(() => null) : null;
  if (!isClaimedMenu(answer)) {
    say('This menu has expired. Click the CometOTP button in the field again.');
    return;
  }
  const claimed = answer;
  site.textContent = claimed.host;
  new ResizeObserver(() => void tell({ type: 'fill-size', menu, height: main.getBoundingClientRect().height })).observe(main);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') void tell({ type: 'fill-close', menu });
  });

  const ask: FillList = { type: 'fill-list', menu };
  const list = await chrome.runtime.sendMessage(ask).catch(() => null);
  if (!isMenuList(list)) say(STATES.locked);
  else if (list.state !== 'ready') say(STATES[list.state]);
  else offerServices(claimed, list);
}

void start();
