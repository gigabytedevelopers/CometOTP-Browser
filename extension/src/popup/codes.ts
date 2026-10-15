// The codes, in the popup: one row per service, in the phone's order, with its current code and
// how long it has left, recomputed as each period turns. Clicking a row copies its code. Rows are
// built with DOM calls, never from HTML, as names come from the vault.
import { generateCode, secondsLeft, type Service } from '@cometotp/protocol';

import { MAX_SKEW_MS, services, syncStatus, type SyncWarning } from '../sync/sync.js';
import { badgeColor, groupCode, initials, matches, skewText, updatedText } from './format.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const list = element<HTMLUListElement>('services');
const search = element<HTMLInputElement>('search');
const empty = element('codes-empty');
const updated = element('updated');
const clockWarning = element('clock-warning');
const syncWarning = element('sync-warning');
const copied = element('copied');

const WARNINGS: Record<SyncWarning, string> = {
  rollback: 'The relay sent an older copy than this browser has, so it was ignored. If this keeps happening, the relay may be holding back updates.',
  'bad-vault': 'The relay sent a copy that does not open, so it was ignored. These are the codes from before.',
  'needs-update': 'Your phone sent its services in a newer format. Update the CometOTP extension to see them.',
  repair: 'The relay no longer knows this browser. Remove it in CometOTP on your phone, then pair it again.',
  unreachable: 'The relay could not be reached. These codes are from the last copy downloaded.',
};

/** A row and the code it shows, for the period it was computed for. */
interface Row {
  service: Service;
  item: HTMLLIElement;
  button: HTMLButtonElement;
  code: HTMLElement;
  bar: HTMLElement;
  counter: number | null;
  value: string;
}

let rows: Row[] = [];
/** The services the rows were built from, to rebuild them only when something changed. */
let shownFrom = '';
let timer: ReturnType<typeof setInterval> | undefined;

function row(service: Service): Row {
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
  const box = document.createElement('span');
  box.className = 'code-box';
  const code = document.createElement('span');
  code.className = 'code';
  const timerTrack = document.createElement('span');
  timerTrack.className = 'timer';
  timerTrack.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('span');
  bar.className = 'timer-bar';
  timerTrack.append(bar);
  box.append(code, timerTrack);
  button.append(badge, names, box);
  item.append(button);
  const entry: Row = { service, item, button, code, bar, counter: null, value: '' };
  button.addEventListener('click', () => void copy(entry));
  return entry;
}

async function copy(entry: Row): Promise<void> {
  if (!entry.value) return;
  await navigator.clipboard.writeText(entry.value);
  entry.button.classList.add('copied');
  entry.code.textContent = 'Copied';
  copied.textContent = `${entry.service.issuer || entry.service.label} code copied`;
  setTimeout(() => {
    entry.button.classList.remove('copied');
    entry.code.textContent = groupCode(entry.value, entry.service.type);
  }, 1200);
}

/** Recomputes codes whose period has turned, and moves every countdown. */
async function tick(): Promise<void> {
  const now = Date.now() / 1000;
  await Promise.all(
    rows.map(async (entry) => {
      const { service } = entry;
      const counter = Math.floor(now / service.period);
      if (counter !== entry.counter) {
        entry.counter = counter;
        entry.value = await generateCode(service, now);
        if (!entry.button.classList.contains('copied')) entry.code.textContent = groupCode(entry.value, service.type);
        entry.button.setAttribute('aria-label', `${service.issuer || service.label}${service.issuer && service.label ? ` (${service.label})` : ''}: ${entry.value.split('').join(' ')}. Copy`);
      }
      const left = secondsLeft(service.period, now);
      entry.bar.style.width = `${(left / service.period) * 100}%`;
      entry.button.classList.toggle('ending', left <= 5);
    }),
  );
}

function filter(): void {
  let shown = 0;
  for (const entry of rows) {
    entry.item.hidden = !matches(entry.service, search.value);
    if (!entry.item.hidden) shown++;
  }
  empty.hidden = !(rows.length && !shown);
  if (rows.length && !shown) empty.textContent = 'No service matches your search.';
}

search.addEventListener('input', filter);

/** Forgets the rows and stops the countdown, once the pairing is gone. */
export function clearCodes(): void {
  clearInterval(timer);
  rows = [];
  shownFrom = '';
  list.replaceChildren();
  search.value = '';
  delete document.body.dataset.codes;
}

/** Shows the copy's services and the sync status; call again after a sync. */
export async function renderCodes(): Promise<void> {
  const data = await services();
  const status = await syncStatus();
  const from = JSON.stringify(data?.payload.services ?? null);
  if (from !== shownFrom) {
    shownFrom = from;
    rows = (data?.payload.services ?? []).map(row);
    list.replaceChildren(...rows.map((r) => r.item));
  }
  if (!data) {
    empty.hidden = false;
    empty.textContent = "Waiting for your phone's services…";
    updated.textContent = '';
  } else {
    empty.hidden = data.payload.services.length > 0;
    empty.textContent = 'No services yet. In CometOTP, turn on Browser extension for the services you want here.';
    const skipped = data.skipped ? ` · ${data.skipped} could not be shown` : '';
    updated.textContent = `${updatedText(data.payload.updated, Date.now())} from ${data.payload.phone}${skipped}`;
    filter();
  }

  const skew = status.skew;
  clockWarning.hidden = skew === null || Math.abs(skew) <= MAX_SKEW_MS;
  if (!clockWarning.hidden) {
    clockWarning.textContent = `This computer's clock is ${skewText(skew!)} off, so its codes may not work. Set the time automatically in its settings.`;
  }
  const stale = status.warning === 'unreachable' && (status.checkedAt === null || Date.now() - status.checkedAt > 30 * 60_000);
  const warning = status.warning === 'unreachable' ? (stale ? 'unreachable' : null) : status.warning;
  syncWarning.hidden = !warning;
  syncWarning.textContent = warning ? WARNINGS[warning] : '';

  clearInterval(timer);
  await tick();
  timer = setInterval(() => void tick(), 1000);
  document.body.dataset.codes = String(rows.length);
}
