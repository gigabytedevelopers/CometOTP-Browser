// Usage statistics, which are off until the person turns them on in the settings (docs/privacy.md).
// Turning them on makes a random id, kept with the other records; turning them off deletes it, so
// nothing that tells this browser apart is kept or sent without consent. Firefox has a switch of
// its own for this kind of data, which must be on too. Only the background sends, so a popup that
// closes cannot cut a request short: pages ask it with a message.
import { deleteRecord, getRecord, putRecord } from '../lock/storage.js';
import type { Usage } from '../messages.js';
import {
  API_SECRET,
  collectUrl,
  isSession,
  measurement,
  newClientId,
  nextSession,
  type BrowserFamily,
  type UsageEvent,
} from './measurement.js';

const RECORD = 'usage-stats';
const SESSION = 'usageSession';

/** Firefox's data type for statistics about how an extension is used. */
export const FIREFOX_DATA_TYPE = 'technicalAndInteraction';

/** Without the stream's secret nothing can be sent, so the settings do not offer it. */
export const usageOffered = API_SECRET !== '';

async function clientId(): Promise<string | null> {
  const value = (await getRecord(RECORD)) as { clientId?: unknown } | undefined;
  return typeof value?.clientId === 'string' ? value.clientId : null;
}

/** Whether the person turned usage statistics on here. */
export async function usageOn(): Promise<boolean> {
  return (await clientId()) !== null;
}

/** Firefox's own switch for usage data; true in browsers that have none. */
export async function browserAllowsUsage(): Promise<boolean> {
  const granted = (await chrome.permissions.getAll()).data_collection;
  return granted === undefined || granted.includes(FIREFOX_DATA_TYPE);
}

/** Asks Firefox to turn its switch on. Call it straight from a click: browsers ask only then. */
export function requestBrowserUsage(): Promise<boolean> {
  return chrome.permissions.request({ data_collection: [FIREFOX_DATA_TYPE] });
}

/** Turns usage statistics on, with a new random id unless there is one. */
export async function turnUsageOn(): Promise<void> {
  if (!(await usageOn())) await putRecord(RECORD, { clientId: newClientId() });
}

/** Turns usage statistics off and deletes the id, and the session with it. */
export async function turnUsageOff(): Promise<void> {
  await deleteRecord(RECORD);
  await chrome.storage.session.remove(SESSION);
}

function browserFamily(): BrowserFamily {
  return chrome.runtime.getURL('').startsWith('moz-extension:') ? 'firefox' : 'chromium';
}

/** Sends `event` to Google Analytics if usage statistics are on and allowed; never fails. */
export async function sendUsage(event: UsageEvent, now = Date.now()): Promise<void> {
  const id = await clientId();
  if (!usageOffered || !id || !(await browserAllowsUsage())) return;
  const stored = (await chrome.storage.session.get(SESSION))[SESSION];
  const session = nextSession(isSession(stored) ? stored : null, now);
  await chrome.storage.session.set({ [SESSION]: session });
  const body = measurement(id, session, event, chrome.runtime.getManifest().version, browserFamily());
  await fetch(collectUrl(), { method: 'POST', body, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }).catch(
    () => undefined,
  );
}

/** From a page: asks the background to send `event`. Nothing happens unless statistics are on. */
export function report(event: UsageEvent): void {
  const message: Usage = { type: 'usage', event };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}
