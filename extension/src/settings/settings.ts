// The settings page, which the popup and the browser's own extension menu open in a tab: this
// browser's pairing (its relay, the name it gives the phone, and Disconnect), the lock (how soon it
// locks, the password and the passkey), and filling codes into sites. In a tab, unlike the popup,
// Firefox shows the passkey and permission prompts without closing the page. What each part says
// is in data attributes on the body, which the load test reads (tools/load-test.ts).
import { hasSiteAccess, removeSiteAccess, requestSiteAccess } from '../fill/access.js';
import { addPasskey, changePassword, localKey, passkeyCredential, removePasskey, state, type LockState } from '../lock/lock.js';
import { PasskeyError, createPasskey, passkeysSupported } from '../lock/passkey.js';
import { MIN_LENGTH, SCORE_LABELS, problem, score } from '../lock/strength.js';
import { OFFICIAL_RELAY } from '../sync/relay.js';
import { chosenRelay, pairingRecord, vaultSecret } from '../sync/store.js';
import { disconnect } from '../sync/sync.js';
import { thisBrowser } from '../pair/browser-name.js';
import { AUTO_LOCK_CHOICES, autoLockText, nameProblem } from './choices.js';
import { autoLockMinutes, pairingName, setAutoLockMinutes, setPairingName } from './prefs.js';

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
  void busy(passwordSubmit, 'Changing…', () => changePassword(passwordCurrent.value, next)).then(
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

/** Shows every part as it is now. Run again when the page comes back into view: the popup may have unlocked meanwhile. */
async function render(): Promise<void> {
  const view = await state();
  stateNote.hidden = view === 'unlocked';
  stateNote.textContent =
    view === 'new'
      ? 'Set a password in CometOTP first: click its button in the toolbar.'
      : 'CometOTP is locked. Some settings need it unlocked: click its button in the toolbar to unlock it.';
  passwordForm.hidden = view === 'new';
  await Promise.all([showBrowser(), showAutoLock(), showPasskey(view), showFilling()]);
  document.body.dataset.view = view;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void render();
});

passwordStrength.textContent = strengthText('');
element('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
void render();
