// The pairing page, opened in a tab from the popup: a tab stays open while the person uses their
// phone. It shows each step of BrowserPairing (./pairing.ts) and keeps what the phone sends under
// the local key. The current step is in `data-step` on the body, and the code's URI in `data-uri`
// on the canvas, which the load test reads in place of a camera (tools/load-test.ts).
import { localKey, state } from '../lock/lock.js';
import * as relayApi from '../sync/relay.js';
import { isRelay, relayUrl } from '../sync/relay.js';
import { chooseRelay, chosenRelay, pairingRecord, storePairing, vaultSecret } from '../sync/store.js';
import { services, sync } from '../sync/sync.js';
import { thisBrowser } from './browser-name.js';
import { BrowserPairing, type PairingFailure, type PairingStep } from './pairing.js';
import { drawQr } from './qr.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

type Step = 'code' | 'compare' | 'finishing' | 'done' | 'failed' | 'locked' | 'paired';
const STEPS: Step[] = ['code', 'compare', 'finishing', 'done', 'failed', 'locked', 'paired'];

function show(step: Step): void {
  for (const name of STEPS) element(`step-${name}`).hidden = name !== step;
  document.body.dataset.step = step;
}

const FAILURES: Record<PairingFailure, [string, string]> = {
  unreachable: ['Could not reach the relay', "Check this computer's connection, or the relay's address, then try again."],
  'cancelled-on-phone': ['Cancelled on your phone', 'Nothing was shared. Try again when you are ready.'],
  cancelled: ['Pairing cancelled', 'Nothing was shared.'],
  expired: ['Pairing took too long', 'A code lasts ten minutes from when it appears. Try again, and finish on your phone.'],
  broken: [
    'Pairing failed',
    'What came back could not be verified, so nothing was kept. If you did not scan the code yourself, someone else may have. Try again with a new code.',
  ],
  'not-stored': ['Pairing could not be finished', 'CometOTP may have locked itself. Unlock it, then try again.'],
};

const canvas = element<HTMLCanvasElement>('qr');
const countdown = element('countdown');
let timer: ReturnType<typeof setInterval> | undefined;
let pairing: BrowserPairing | null = null;
/** Steps from a pairing that was replaced (a new relay chosen, say) are ignored. */
let generation = 0;

function startCountdown(expiresAt: number): void {
  clearInterval(timer);
  const tick = () => {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    countdown.textContent = left
      ? `This code changes in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      : 'Making a new code…';
  };
  tick();
  timer = setInterval(tick, 1000);
}

function onStep(step: PairingStep): void {
  if (step.step !== 'code') clearInterval(timer);
  switch (step.step) {
    case 'code':
      drawQr(canvas, step.uri);
      canvas.dataset.uri = step.uri;
      startCountdown(step.expiresAt);
      show('code');
      break;
    case 'compare':
      delete canvas.dataset.uri;
      element('sas').textContent = step.sas;
      element('compare-phone').textContent = step.phone;
      show('compare');
      element('confirm').focus();
      break;
    case 'finishing':
      element('finishing-phone').textContent = step.phone;
      show('finishing');
      break;
    case 'done': {
      element('done-title').textContent = `Paired with ${step.phone}`;
      const count = step.services;
      element('done-message').textContent =
        count === null
          ? 'Its services will arrive as soon as your phone has sent them.'
          : `This browser now keeps an encrypted copy of ${count} ${count === 1 ? 'service' : 'services'} from your phone.`;
      show('done');
      element('done-close').focus();
      break;
    }
    case 'failed': {
      const [title, message] = FAILURES[step.reason];
      element('failed-title').textContent = title;
      element('failed-message').textContent = message;
      document.body.dataset.failure = step.reason;
      show('failed');
      break;
    }
  }
}

async function start(): Promise<void> {
  const mine = ++generation;
  pairing?.cancel();
  pairing = null;
  delete document.body.dataset.failure;
  if ((await state()) !== 'unlocked') return show('locked');
  if (await pairingRecord()) {
    const key = await localKey();
    element('paired-phone').textContent = (key && (await vaultSecret(key))?.phone) || 'your phone';
    return show('paired');
  }
  const relay = await chosenRelay();
  element('relay-name').textContent = new URL(relay).host;
  const current = new BrowserPairing({
    relay,
    browserName: thisBrowser(),
    api: relayApi,
    async store(paired) {
      const key = await localKey();
      if (!key) throw new Error('Locked');
      await storePairing(paired, key);
    },
    async download() {
      await sync();
      return (await services())?.payload.services.length ?? null;
    },
    onStep: (step) => {
      if (mine === generation) onStep(step);
    },
  });
  pairing = current;
  void current.run();
}

// Choosing the relay, which starts a new code through it.
const relayForm = element<HTMLFormElement>('relay-form');
const relayInput = element<HTMLInputElement>('relay-input');
const relayError = element('relay-error');
const relaySave = element<HTMLButtonElement>('relay-save');

element('relay-change').addEventListener('click', () => {
  relayForm.hidden = false;
  relayInput.focus();
});

relayForm.addEventListener('submit', (event) => {
  event.preventDefault();
  relayError.textContent = '';
  let relay: string;
  try {
    relay = relayUrl(relayInput.value);
  } catch {
    relayError.textContent = 'Use the relay\'s https address, such as https://relay.example.com.';
    return;
  }
  relaySave.disabled = true;
  void isRelay(relay).then(async (ok) => {
    relaySave.disabled = false;
    if (!ok) {
      relayError.textContent = 'No CometOTP relay answers at that address.';
      return;
    }
    await chooseRelay(relay);
    relayForm.hidden = true;
    await start();
  });
});

element('relay-official').addEventListener('click', () => {
  relayForm.hidden = true;
  void chooseRelay(null).then(start);
});

element('confirm').addEventListener('click', () => pairing?.confirm());
element('compare-cancel').addEventListener('click', () => pairing?.cancel());
element('finishing-cancel').addEventListener('click', () => pairing?.cancel());
element('retry').addEventListener('click', () => void start());
element('done-close').addEventListener('click', () => window.close());
// Leaving the page cancels a pairing under way, telling the phone when it can.
addEventListener('pagehide', () => pairing?.cancel());

void start();
