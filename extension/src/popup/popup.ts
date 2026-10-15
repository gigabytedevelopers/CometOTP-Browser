// The popup: setting the password the first time, unlocking with it or a passkey, the codes, and
// locking again; everything else is on the settings page, which it opens in a tab. Which of the
// three screens it shows is in `data-view` on the body.
// It also pings the background and records the answer in `data-background`; the load test waits
// for both (tools/load-test.ts).
import { lock, passkeyCredential, reset, setUp, state, unlock, unlockWithPasskey, type LockState } from '../lock/lock.js';
import { passkeyOutput, passkeysNeedTab, passkeysSupported } from '../lock/passkey.js';
import { autoLockText } from '../settings/choices.js';
import { autoLockMinutes } from '../settings/prefs.js';
import { pairingRecord } from '../sync/store.js';
import { clearNotice, notice, sync } from '../sync/sync.js';
import { clearCodes, renderCodes } from './codes.js';
import { MIN_LENGTH, SCORE_LABELS, problem, score } from '../lock/strength.js';
import { isPong } from '../messages.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const views: Record<LockState, HTMLElement> = {
  new: element('setup'),
  locked: element('locked'),
  unlocked: element('unlocked'),
};

const settingsButton = element<HTMLButtonElement>('settings');

function show(view: LockState): void {
  for (const [name, section] of Object.entries(views)) section.hidden = name !== view;
  document.body.dataset.view = view;
  settingsButton.hidden = view === 'new';
  const focus = { new: 'setup-password', locked: 'unlock-password', unlocked: 'lock' }[view];
  element(focus).focus();
  void showPasskey(view);
  if (view === 'unlocked') void showPairing();
}

settingsButton.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});

void autoLockMinutes().then((minutes) => {
  element('lock-hint').textContent = `CometOTP locks itself after ${autoLockText(minutes)} without use, when the computer locks and when the browser quits.`;
});

// Once paired, the codes; before, pairing, which happens in a tab of its own: it stays open while
// the person uses their phone.
const unpaired = element('unpaired');
const codesPanel = element('codes');
const noticeLine = element('notice');
const pairingStatus = element('pairing-status');
const pairButton = element<HTMLButtonElement>('pair');

async function showPairing(): Promise<void> {
  const paired = Boolean(await pairingRecord());
  unpaired.hidden = paired;
  codesPanel.hidden = !paired;
  document.body.dataset.paired = paired ? 'yes' : 'no';
  if (!paired) {
    clearCodes();
    const said = await notice();
    noticeLine.hidden = said !== 'disconnected';
    noticeLine.textContent = 'Your phone removed this browser, so its copy was deleted. Pair it again to use your codes here.';
    pairingStatus.textContent = 'Pair this browser with CometOTP on your phone to use your codes here.';
    if (said) await clearNotice();
    return;
  }
  // The copy at once, then whatever a download brings (protocol §7.2: on unlock and on opening).
  await renderCodes();
  await sync();
  if (await pairingRecord()) await renderCodes();
  else await showPairing();
}

pairButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('pair/pair.html') });
  window.close();
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens the passkey page in a tab, for Firefox, which closes popups when the prompt appears. */
function passkeyTab(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('passkey/passkey.html') });
  window.close();
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

// Setting the password.
const setupPassword = element<HTMLInputElement>('setup-password');
const setupConfirm = element<HTMLInputElement>('setup-confirm');
const setupMeter = element('setup-meter');
const setupStrength = element('setup-strength');
const setupError = element('setup-error');
const setupSubmit = element<HTMLButtonElement>('setup-submit');

setupPassword.addEventListener('input', () => {
  const password = setupPassword.value;
  const strength = score(password);
  if (password) setupMeter.dataset.score = String(strength);
  else delete setupMeter.dataset.score;
  setupMeter.setAttribute('aria-valuenow', String(password ? strength : 0));
  setupStrength.textContent = password
    ? `${SCORE_LABELS[strength]}${[...password].length < MIN_LENGTH ? ` · at least ${MIN_LENGTH} characters` : ''}`
    : `At least ${MIN_LENGTH} characters. A few unrelated words make a strong one.`;
  setupError.textContent = '';
});

element('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const password = setupPassword.value;
  const why = problem(password) ?? (password === setupConfirm.value ? null : 'The two passwords differ.');
  setupError.textContent = why ?? '';
  if (why) return;
  void busy(setupSubmit, 'Setting up…', () => setUp(password)).then(
    () => {
      setupPassword.value = '';
      setupConfirm.value = '';
      show('unlocked');
    },
    (error: unknown) => {
      setupError.textContent = `Could not set the password: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
});

// Unlocking, and resetting for someone who has forgotten the password.
const unlockPassword = element<HTMLInputElement>('unlock-password');
const unlockError = element('unlock-error');
const unlockSubmit = element<HTMLButtonElement>('unlock-submit');
const resetPanel = element('reset');

element('unlock-form').addEventListener('submit', (event) => {
  event.preventDefault();
  unlockError.textContent = '';
  void busy(unlockSubmit, 'Unlocking…', () => unlock(unlockPassword.value)).then((unlocked) => {
    unlockPassword.value = '';
    if (unlocked) show('unlocked');
    else {
      unlockError.textContent = 'Wrong password.';
      unlockPassword.focus();
    }
  });
});

element('forgot').addEventListener('click', () => {
  resetPanel.hidden = false;
});
element('reset-cancel').addEventListener('click', () => {
  resetPanel.hidden = true;
});
element('reset-submit').addEventListener('click', () => {
  void reset().then(() => {
    resetPanel.hidden = true;
    show('new');
  });
});

// Locking.
element('lock').addEventListener('click', () => {
  void lock().then(() => show('locked'));
});

// Unlocking with a passkey, where the browser supports the PRF extension and one was added on the
// settings page.
const passkeyUnlock = element('passkey-unlock');
const passkeyUnlockSubmit = element<HTMLButtonElement>('passkey-unlock-submit');
const passkeyUnlockError = element('passkey-unlock-error');

async function showPasskey(view: LockState): Promise<void> {
  const supported = await passkeysSupported();
  const credential = supported ? await passkeyCredential() : null;
  passkeyUnlock.hidden = !(view === 'locked' && credential);
  if (view === 'locked' && credential) passkeyUnlockSubmit.focus();
  document.body.dataset.passkey = credential ? 'added' : supported ? 'none' : 'unsupported';
}

passkeyUnlockSubmit.addEventListener('click', () => {
  if (passkeysNeedTab()) return passkeyTab();
  passkeyUnlockError.textContent = '';
  void busy(passkeyUnlockSubmit, 'Waiting for the passkey…', async () => {
    const credential = await passkeyCredential();
    if (!credential) return false;
    return unlockWithPasskey(await passkeyOutput(credential));
  }).then(
    (unlocked) => {
      if (unlocked) show('unlocked');
      else passkeyUnlockError.textContent = 'That passkey did not unlock CometOTP. Use your password.';
    },
    (error: unknown) => {
      passkeyUnlockError.textContent = message(error);
    },
  );
});

element('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
void state().then(show);

chrome.runtime.sendMessage({ type: 'ping' }).then(
  (reply) => {
    if (isPong(reply)) document.body.dataset.background = reply.version;
  },
  () => {
    document.body.dataset.background = 'unreachable';
  },
);
