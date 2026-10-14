// The extension's background: a service worker in Chromium and a background script in Firefox,
// both loaded as a module. It locks the extension after 15 minutes without input and when the
// computer locks (Firefox does not report the latter, so there the idle time applies). Quitting
// the browser locks it too, as storage.session is cleared. It also answers the popup's ping with
// its version, which shows that the two can talk (tools/load-test.ts relies on it).
import { lock } from './lock/lock.js';
import { isPing, type Pong } from './messages.js';

/** Seconds without input before the extension locks itself. */
const AUTO_LOCK_SECONDS = 15 * 60;

chrome.idle.setDetectionInterval(AUTO_LOCK_SECONDS);
chrome.idle.onStateChanged.addListener((state) => {
  if (state !== 'active') void lock();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isPing(message)) {
    const pong: Pong = { type: 'pong', version: chrome.runtime.getManifest().version };
    sendResponse(pong);
  }
});
