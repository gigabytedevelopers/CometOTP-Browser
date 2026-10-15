// The extension's background: a service worker in Chromium and a background script in Firefox,
// both loaded as a module. It locks the extension after a time without input (15 minutes unless
// chosen in its settings) and when the computer locks (Firefox does not report the latter, so there the idle time applies). Quitting
// the browser locks it too, as storage.session is cleared. It keeps the vault current, downloading
// at start-up and every 15 minutes (protocol §7.2). Once the person allows access to sites, it
// runs the content script that puts a CometOTP button in code fields, and serves its menus. It also
// answers the popup's ping with its version, which shows that the two can talk
// (tools/load-test.ts relies on it).
import { updateContentScript } from './fill/access.js';
import { chooseService, claimMenu, listMenu, mayFill, openMenu, passOn } from './fill/menus.js';
import { isFillChoose, isFillClaim, isFillClose, isFillHere, isFillList, isFillOpen, isFillSize } from './fill/messages.js';
import { lock } from './lock/lock.js';
import { isPing, type Pong } from './messages.js';
import { autoLockMinutes } from './settings/prefs.js';
import { sync } from './sync/sync.js';

// The time without input before locking is a setting (15 minutes unless chosen), set again each
// time the background starts; the settings page sets it at once when it changes.
void autoLockMinutes().then((minutes) => chrome.idle.setDetectionInterval(minutes * 60));
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
chrome.runtime.onStartup.addListener(() => {
  void sync();
  void updateContentScript();
});

// The content script runs exactly while access to sites is granted, however it was granted or
// taken back: from the popup, or in the browser's settings for the extension.
chrome.runtime.onInstalled.addListener(() => void updateContentScript());
chrome.permissions.onAdded.addListener(() => void updateContentScript(true));
chrome.permissions.onRemoved.addListener(() => void updateContentScript());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isPing(message)) {
    const pong: Pong = { type: 'pong', version: chrome.runtime.getManifest().version };
    sendResponse(pong);
  } else if (isFillHere(message)) {
    sendResponse(mayFill(sender));
  } else if (isFillOpen(message)) {
    void openMenu(sender).then(sendResponse);
    return true;
  } else if (isFillClaim(message)) {
    void claimMenu(message.menu, sender).then(sendResponse);
    return true;
  } else if (isFillList(message)) {
    void listMenu(message.menu, sender).then(sendResponse);
    return true;
  } else if (isFillChoose(message)) {
    void chooseService(message.menu, message.service, sender).then(sendResponse, () => sendResponse(false));
    return true;
  } else if (isFillSize(message) || isFillClose(message)) {
    void passOn(message, sender);
  }
  return undefined;
});
