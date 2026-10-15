// The extension's background: a service worker in Chromium and a background script in Firefox,
// both loaded as a module. It locks the extension after 15 minutes without input and when the
// computer locks (Firefox does not report the latter, so there the idle time applies). Quitting
// the browser locks it too, as storage.session is cleared. It keeps the vault current, downloading
// at start-up and every 15 minutes (protocol §7.2). It also answers the popup's ping with its
// version, which shows that the two can talk (tools/load-test.ts relies on it).
import { lock } from './lock/lock.js';
import { isPing, type Pong } from './messages.js';
import { sync } from './sync/sync.js';

/** Seconds without input before the extension locks itself. */
const AUTO_LOCK_SECONDS = 15 * 60;

chrome.idle.setDetectionInterval(AUTO_LOCK_SECONDS);
chrome.idle.onStateChanged.addListener((state) => {
  if (state !== 'active') void lock();
});

/** Minutes between downloads; the popup downloads whenever it opens too. */
const SYNC_MINUTES = 15;

// The alarm outlives the background being stopped; it is made once, so its schedule is kept.
void chrome.alarms.get('sync').then((alarm) => {
  if (!alarm) void chrome.alarms.create('sync', { periodInMinutes: SYNC_MINUTES, delayInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') void sync();
});
chrome.runtime.onStartup.addListener(() => void sync());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isPing(message)) {
    const pong: Pong = { type: 'pong', version: chrome.runtime.getManifest().version };
    sendResponse(pong);
  }
});
