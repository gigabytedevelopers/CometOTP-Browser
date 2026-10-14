// The popup: setting the password the first time, unlocking, and locking again. Which of the
// three it shows is in `data-view` on the body. It also pings the background and records the
// answer in `data-background`; the load test waits for both (tools/load-test.ts).
import { lock, reset, setUp, state, unlock, type LockState } from '../lock/lock.js';
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

function show(view: LockState): void {
  for (const [name, section] of Object.entries(views)) section.hidden = name !== view;
  document.body.dataset.view = view;
  const focus = { new: 'setup-password', locked: 'unlock-password', unlocked: 'lock' }[view];
  element(focus).focus();
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
