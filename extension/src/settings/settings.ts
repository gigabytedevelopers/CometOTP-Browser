// The settings page, which the popup and the browser's own extension menu open in a tab: this
// browser's pairing (its relay, the name it gives the phone, and Disconnect), the lock (how soon it
// locks, the password and the passkey), filling codes into sites and the sites each service is
// linked to, usage statistics, and updates. In a tab,
// unlike the popup, Firefox shows the passkey and permission prompts without closing the page.
// What each part says is in data attributes on the body, which the load test reads
// (tools/load-test.ts).
import { hasSiteAccess, removeSiteAccess, requestSiteAccess } from '../fill/access.js';
import { forgetLink, readHidden, readLinks, unhide } from '../fill/links.js';
import { addPasskey, changePassword, localKey, onLockChange, passkeyCredential, removePasskey, state, type LockState } from '../lock/lock.js';
import { PasskeyError, createPasskey, passkeysSupported } from '../lock/passkey.js';
import { MIN_LENGTH, SCORE_LABELS, problem, score } from '../lock/strength.js';
import { OFFICIAL_RELAY } from '../sync/relay.js';
import { chosenRelay, pairingRecord, vaultSecret } from '../sync/store.js';
import { disconnect, services } from '../sync/sync.js';
import { thisBrowser } from '../pair/browser-name.js';
import { browserAllowsUsage, report, requestBrowserUsage, turnUsageOff, turnUsageOn, usageOffered, usageOn } from '../usage/usage.js';
import { AUTO_LOCK_CHOICES, autoLockText, nameProblem } from './choices.js';
import { autoLockMinutes, pairingName, setAutoLockMinutes, setPairingName } from './prefs.js';
import { FIRST_SITES, findSites, firstSites, siteCount, siteServices, withoutSite, type SiteKind, type SiteService } from './site-list.js';
import { checkedState, startState, updateText, type UpdateState } from './update.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `work` with `button` disabled and showing `busyText`, as Argon2 takes a moment. */
async function busy<T>(button: HTMLButtonElement, busyText: string, work: () => Promise<T>): Promise<T> {
  const text = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}

const stateNote = element('state-note');

// This browser: its pairing, its relay, its name, and Disconnect.
const pairedStatus = element('paired-status');
const relayLine = element('relay');
const nameInput = element<HTMLInputElement>('name');
const nameHint = element('name-hint');
const nameError = element('name-error');
const nameDone = element('name-done');
const disconnectPanel = element('disconnect-panel');
const disconnectButton = element<HTMLButtonElement>('disconnect');
const disconnectConfirm = element('disconnect-confirm');
const disconnectYes = element<HTMLButtonElement>('disconnect-yes');
const disconnectDone = element('disconnect-done');

function relayText(relay: string): string {
  return relay === OFFICIAL_RELAY ? `${new URL(relay).host} (the official relay)` : new URL(relay).host;
}

async function showBrowser(): Promise<void> {
  const record = await pairingRecord();
  const key = record ? await localKey() : null;
  const phone = key ? (await vaultSecret(key))?.phone : null;
  const since = record ? new Date(record.pairedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
  pairedStatus.textContent = record ? `Paired with ${phone ?? 'your phone'} since ${since}.` : 'Not paired with a phone.';
  relayLine.textContent = relayText(record?.relay ?? (await chosenRelay()));
  nameInput.value = await pairingName();
  nameInput.placeholder = thisBrowser();
  nameHint.textContent = record
    ? 'Your phone shows the name this browser had when it paired. To rename it there, use Connected extensions in CometOTP. This name is for the next pairing.'
    : 'Your phone shows this name when you pair.';
  disconnectPanel.hidden = !record;
  disconnectConfirm.hidden = true;
  disconnectButton.hidden = false;
  document.body.dataset.paired = record ? 'yes' : 'no';
}

element('name-form').addEventListener('submit', (event) => {
  event.preventDefault();
  nameDone.textContent = '';
  const why = nameProblem(nameInput.value);
  nameError.textContent = why ?? '';
  if (why) return;
  void setPairingName(nameInput.value).then(
    async () => {
      nameInput.value = await pairingName();
      nameDone.textContent = 'Saved.';
    },
    (error: unknown) => {
      nameError.textContent = message(error);
    },
  );
});

disconnectButton.addEventListener('click', () => {
  disconnectButton.hidden = true;
  disconnectConfirm.hidden = false;
  disconnectYes.focus();
});

element('disconnect-cancel').addEventListener('click', () => {
  disconnectConfirm.hidden = true;
  disconnectButton.hidden = false;
});

disconnectYes.addEventListener('click', () => {
  void busy(disconnectYes, 'Disconnecting…', () => disconnect()).then(async (told) => {
    report('browser_disconnected');
    disconnectDone.hidden = false;
    disconnectDone.textContent = told
      ? 'Disconnected. This browser has no copy of your codes any more, and your phone shows it as disconnected the next time it syncs.'
      : 'Disconnected here: this browser has no copy of your codes any more. The relay could not be reached, so remove this browser in CometOTP on your phone too.';
    document.body.dataset.disconnected = told ? 'relay' : 'here';
    await showBrowser();
  });
});

// The lock: how soon it locks, the password and the passkey.
const autoLock = element<HTMLSelectElement>('auto-lock');
const passwordForm = element<HTMLFormElement>('password-form');
const passwordCurrent = element<HTMLInputElement>('password-current');
const passwordNew = element<HTMLInputElement>('password-new');
const passwordConfirm = element<HTMLInputElement>('password-confirm');
const passwordMeter = element('password-meter');
const passwordStrength = element('password-strength');
const passwordError = element('password-error');
const passwordDone = element('password-done');
const passwordSubmit = element<HTMLButtonElement>('password-submit');

for (const minutes of AUTO_LOCK_CHOICES) {
  const option = document.createElement('option');
  option.value = String(minutes);
  option.textContent = autoLockText(minutes);
  autoLock.append(option);
}

async function showAutoLock(): Promise<void> {
  const minutes = await autoLockMinutes();
  autoLock.value = String(minutes);
  document.body.dataset.autoLock = String(minutes);
}

autoLock.addEventListener('change', () => {
  const minutes = Number(autoLock.value);
  void setAutoLockMinutes(minutes).then(() => {
    chrome.idle.setDetectionInterval(minutes * 60);
    document.body.dataset.autoLock = String(minutes);
  });
});

function strengthText(password: string): string {
  if (!password) return `At least ${MIN_LENGTH} characters. A few unrelated words make a strong one.`;
  const short = [...password].length < MIN_LENGTH ? ` · at least ${MIN_LENGTH} characters` : '';
  return `${SCORE_LABELS[score(password)]}${short}`;
}

passwordNew.addEventListener('input', () => {
  const password = passwordNew.value;
  if (password) passwordMeter.dataset.score = String(score(password));
  else delete passwordMeter.dataset.score;
  passwordMeter.setAttribute('aria-valuenow', String(password ? score(password) : 0));
  passwordStrength.textContent = strengthText(password);
  passwordError.textContent = '';
});

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  passwordDone.textContent = '';
  const next = passwordNew.value;
  const why =
    problem(next) ??
    (next !== passwordConfirm.value ? 'The two new passwords differ.' : next === passwordCurrent.value ? 'That is the current password.' : null);
  passwordError.textContent = why ?? '';
  if (why) return;
  void busy(passwordSubmit, 'Changing…', async () => {
    // Removing the passkey meanwhile would be kept (src/lock/lock.ts), but waiting is clearer.
    passkeyRemove.disabled = true;
    try {
      return await changePassword(passwordCurrent.value, next);
    } finally {
      passkeyRemove.disabled = false;
    }
  }).then(
    (changed) => {
      if (!changed) {
        passwordError.textContent = 'The current password is wrong.';
        passwordCurrent.focus();
        return;
      }
      for (const input of [passwordCurrent, passwordNew, passwordConfirm]) input.value = '';
      delete passwordMeter.dataset.score;
      passwordStrength.textContent = strengthText('');
      passwordDone.textContent = 'Password changed. Use the new one from now on.';
      document.body.dataset.password = 'changed';
    },
    (error: unknown) => {
      passwordError.textContent = `Could not change the password: ${message(error)}`;
    },
  );
});

// Passkeys, where the browser supports the PRF extension. Adding one seals the local key, so it
// needs the extension unlocked; removing one does not.
const passkeyPanel = element('passkey');
const passkeyStatus = element('passkey-status');
const passkeyAdd = element<HTMLButtonElement>('passkey-add');
const passkeyRemove = element<HTMLButtonElement>('passkey-remove');
const passkeyError = element('passkey-error');

async function showPasskey(view: LockState): Promise<void> {
  const supported = await passkeysSupported();
  const credential = supported ? await passkeyCredential() : null;
  passkeyPanel.hidden = !supported || view === 'new';
  passkeyStatus.textContent =
    view === 'locked'
      ? 'Unlock CometOTP from its button in the toolbar to add a passkey.'
      : credential
        ? 'A passkey can unlock CometOTP. Your password keeps working.'
        : 'Unlock with Touch ID, Windows Hello, your phone or a security key instead of typing your password. Your password keeps working.';
  passkeyAdd.textContent = credential ? 'Replace the passkey' : 'Add a passkey';
  passkeyAdd.disabled = view !== 'unlocked';
  passkeyRemove.hidden = !credential;
  document.body.dataset.passkey = credential ? 'added' : supported ? 'none' : 'unsupported';
}

passkeyAdd.addEventListener('click', () => {
  passkeyError.textContent = '';
  void busy(passkeyAdd, 'Waiting for the passkey…', async () => {
    const { credential, prf } = await createPasskey();
    await addPasskey(credential, prf);
  }).then(
    () => render(),
    (error: unknown) => {
      passkeyError.textContent = error instanceof PasskeyError ? error.message : `Could not add the passkey: ${message(error)}`;
      void render();
    },
  );
});

passkeyRemove.addEventListener('click', () => {
  void removePasskey().then(() => render());
});

// Filling codes into sites, which needs access to them, asked for here and never at install. The
// request must start in the click itself; the background runs the content script once granted.
const fillingStatus = element('filling-status');
const fillingOn = element<HTMLButtonElement>('filling-on');
const fillingOff = element<HTMLButtonElement>('filling-off');

async function showFilling(): Promise<void> {
  const on = await hasSiteAccess();
  fillingStatus.textContent = on
    ? 'On: code fields on sites show a CometOTP button. Choose a service there to fill its code.'
    : 'Show a CometOTP button in code fields on sites, to fill a code without copying it. Your browser will ask to let CometOTP read and change sites: it only looks for code fields, and a site gets only the code you choose.';
  fillingOn.hidden = on;
  fillingOff.hidden = !on;
  document.body.dataset.filling = on ? 'on' : 'off';
}

fillingOn.addEventListener('click', () => {
  void requestSiteAccess()
    .catch(() => false)
    .then(() => showFilling());
});
fillingOff.addEventListener('click', () => {
  void removeSiteAccess()
    .catch(() => false)
    .then(() => showFilling());
});

// The sites each service was filled on, where the menu offers it first, and those the person took
// it off, where its name no longer offers it. A wrong one is forgotten here, as well as from the
// menu on the site itself. They are sealed under the local key, so this needs CometOTP unlocked.
// There can be many, so past the first few a search finds them, and a button shows them all.
// Forgetting one changes its row only: the rest stay where they were, and focus moves to the next.
const sitesPanel = element('sites');
const sitesTitle = element('sites-title');
const sitesStatus = element('sites-status');
const sitesSearch = element<HTMLInputElement>('sites-search');
const sitesFound = element('sites-found');
const sitesList = element<HTMLUListElement>('sites-list');
const sitesAll = element<HTMLButtonElement>('sites-all');

/** The services with sites, as last read; and whether the person asked to see all of them. */
let siteList: SiteService[] = [];
let allSites = false;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const siteButtons = () => [...sitesList.querySelectorAll<HTMLButtonElement>('button')];

/**
 * Shows `siteList` as the search and Show all have it. Focus moves to the row button at `focus`,
 * or the last one, if given; otherwise a row button that had it keeps it, as long as its row stays.
 */
function drawSites(focus?: number): void {
  const active = siteButtons().find((button) => button === document.activeElement);
  const index = focus ?? (active ? siteButtons().indexOf(active) : -1);
  const total = siteCount(siteList);
  const query = sitesSearch.value.trim();
  const found = findSites(siteList, query);
  const shown = allSites ? found : firstSites(found, FIRST_SITES);
  sitesList.replaceChildren(...shown.map(siteRow));

  sitesStatus.textContent = total
    ? `${plural(total, 'site', 'sites')} for ${plural(siteList.length, 'service', 'services')}. The CometOTP button in code fields offers a service first on the sites you filled it on, and not on sites you took it off. Remove a site that is wrong.`
    : 'No service is linked to a site yet. When you fill a code on a site, its service is offered there first from then on.';
  sitesSearch.hidden = total <= FIRST_SITES && !query;
  const matched = siteCount(found);
  sitesFound.textContent = !query ? '' : matched ? `${matched} of ${plural(total, 'site matches', 'sites match')}.` : 'No site or service matches your search.';
  sitesAll.hidden = siteCount(shown) === matched;
  sitesAll.textContent = `Show all ${matched} sites`;
  document.body.dataset.sites = String(total);

  if (index < 0) return;
  const buttons = siteButtons();
  const kept = focus === undefined ? buttons.find((button) => button.dataset.site === active?.dataset.site) : undefined;
  (kept ?? buttons[Math.min(index, buttons.length - 1)] ?? (sitesSearch.hidden ? sitesTitle : sitesSearch)).focus();
}

/** Forgets `site` for the row's service, then takes it out of the list. */
function forgetSite(button: HTMLButtonElement, id: string, kind: SiteKind, site: string): void {
  const index = siteButtons().indexOf(button);
  button.disabled = true;
  void (async () => {
    const key = await localKey();
    // Locked meanwhile: the page shows that instead.
    if (!key) return render();
    await (kind === 'filled' ? forgetLink : unhide)(key, id, site);
    siteList = withoutSite(siteList, id, kind, site);
    drawSites(index);
  })().catch(() => render());
}

function siteRow({ service, filled, hidden }: SiteService): HTMLLIElement {
  const item = document.createElement('li');
  const name = document.createElement('p');
  name.className = 'site-service';
  name.textContent = service.issuer && service.label ? `${service.issuer} (${service.label})` : service.issuer || service.label;
  const sites = document.createElement('ul');
  const line = (kind: SiteKind, site: string, text: string, action: string, label: string) => {
    const row = document.createElement('li');
    const what = document.createElement('span');
    what.textContent = text;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link';
    button.textContent = action;
    button.setAttribute('aria-label', label);
    button.dataset.site = JSON.stringify([kind, service.id, site]);
    button.addEventListener('click', () => forgetSite(button, service.id, kind, site));
    row.append(what, button);
    sites.append(row);
  };
  for (const site of filled) line('filled', site, `Filled on ${site}`, 'Remove', `Stop offering ${name.textContent} first on ${site}`);
  for (const site of hidden) line('hidden', site, `Not offered on ${site}`, 'Offer again', `Offer ${name.textContent} on ${site} again`);
  item.append(name, sites);
  return item;
}

sitesSearch.addEventListener('input', () => drawSites());
sitesAll.addEventListener('click', () => {
  // Focus goes to the first site it shows.
  const shown = siteButtons().length;
  allSites = true;
  drawSites(shown);
});

async function showSites(view: LockState): Promise<void> {
  const record = await pairingRecord();
  const key = record && view === 'unlocked' ? await localKey() : null;
  sitesPanel.hidden = !record;
  if (!record || !key) {
    // Nothing of the list stays, the search included, as it may name a site.
    siteList = [];
    allSites = false;
    sitesSearch.value = '';
    sitesList.replaceChildren();
    sitesSearch.hidden = sitesAll.hidden = true;
    sitesFound.textContent = '';
    sitesStatus.textContent = 'Unlock CometOTP from its button in the toolbar to see the sites your services are linked to.';
    document.body.dataset.sites = record ? 'locked' : 'unpaired';
    return;
  }
  // Read again, then shown at once: the list is not emptied while it waits.
  const [data, links, hidden] = await Promise.all([services(), readLinks(key), readHidden(key)]);
  siteList = siteServices(data?.payload.services ?? [], links, hidden);
  drawSites();
}

// Usage statistics, off until the person turns them on here (docs/privacy.md). In Firefox, its own
// switch for usage data must be on too: asking for it must start in the click itself, so whether
// to ask is worked out beforehand.
const usagePanel = element('usage');
const usageStatus = element('usage-status');
const usageOnButton = element<HTMLButtonElement>('usage-on');
const usageOffButton = element<HTMLButtonElement>('usage-off');
let askBrowser = false;

/** What usage statistics send, after "CometOTP". */
const USAGE_SENT =
  'tells Google Analytics when you open it, copy or fill a code, and pair or disconnect this browser, with its version and whether the browser is Firefox or Chrome-like, under a random ID made for this. Never your codes, your services or the sites you use.';

async function showUsage(): Promise<void> {
  const on = await usageOn();
  const allowed = await browserAllowsUsage();
  askBrowser = !allowed;
  usagePanel.hidden = !usageOffered;
  usageStatus.textContent = !on
    ? `Off. If you turn them on, CometOTP ${USAGE_SENT} Turning them off deletes the ID.`
    : allowed
      ? `On: CometOTP ${USAGE_SENT} Turning them off stops them and deletes the ID.`
      : "On here, but Firefox's own setting for technical and interaction data is off, so nothing is sent. Turn on to let Firefox ask you again.";
  usageOnButton.hidden = on && allowed;
  usageOffButton.hidden = !on;
  document.body.dataset.usage = !usageOffered ? 'unavailable' : !on ? 'off' : allowed ? 'on' : 'blocked';
}

usageOnButton.addEventListener('click', () => {
  const asked = askBrowser ? requestBrowserUsage() : Promise.resolve(true);
  void asked
    .catch(() => false)
    .then(async (granted) => {
      if (granted) await turnUsageOn();
    })
    .then(() => showUsage());
});
usageOffButton.addEventListener('click', () => {
  void turnUsageOff().then(() => showUsage());
});

// Updates, sooner than the browser's own schedule (src/settings/update.ts). The page listens for a
// downloaded update only while it is open, and then restarts the extension to install it at once,
// as Firefox would if nothing listened. Firefox cannot be asked to check, so it gets no button.
const updateStatus = element('update-status');
const updateCheck = element<HTMLButtonElement>('update-check');
const updateRestart = element<HTMLButtonElement>('update-restart');
const version = chrome.runtime.getManifest().version;
const canCheck = chrome.runtime.requestUpdateCheck !== undefined;

function showUpdate(update: UpdateState): void {
  updateStatus.textContent = updateText(update, version);
  updateCheck.hidden = update.kind === 'folder' || update.kind === 'manual' || update.kind === 'installing';
  updateCheck.disabled = update.kind === 'checking' || update.kind === 'downloading';
  updateRestart.hidden = update.kind !== 'downloading';
  document.body.dataset.update = update.kind;
}

void chrome.management.getSelf().then(
  (self) => showUpdate(startState(self.installType, canCheck)),
  () => showUpdate(startState('other', canCheck)),
);

updateCheck.addEventListener('click', () => {
  const check = chrome.runtime.requestUpdateCheck?.();
  if (!check) return showUpdate({ kind: 'manual' });
  showUpdate({ kind: 'checking' });
  void check.then(
    (result) => showUpdate(checkedState(result)),
    (error: unknown) => showUpdate({ kind: 'failed', reason: message(error) }),
  );
});

updateRestart.addEventListener('click', () => chrome.runtime.reload());

chrome.runtime.onUpdateAvailable.addListener((details) => {
  showUpdate({ kind: 'installing', version: details.version });
  setTimeout(() => chrome.runtime.reload(), 2000);
});

/** Shows every part as it is now. Run again when the extension locks or unlocks, and when the page comes back into view. */
async function render(): Promise<void> {
  const view = await state();
  stateNote.hidden = view === 'unlocked';
  stateNote.textContent =
    view === 'new'
      ? 'Set a password in CometOTP first: click its button in the toolbar.'
      : 'CometOTP is locked. Some settings need it unlocked: click its button in the toolbar to unlock it.';
  passwordForm.hidden = view === 'new';
  await Promise.all([showBrowser(), showAutoLock(), showPasskey(view), showFilling(), showSites(view), showUsage()]);
  document.body.dataset.view = view;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void render();
});
onLockChange(() => void render());

passwordStrength.textContent = strengthText('');
element('version').textContent = `Version ${version}`;
void render();
