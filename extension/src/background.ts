// The extension's background: a service worker in Chromium and a background script in Firefox,
// both loaded as a module. For now it only answers the popup's ping with its version, which shows
// that the two can talk (tools/load-test.ts relies on it).
import { isPing, type Pong } from './messages.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isPing(message)) {
    const pong: Pong = { type: 'pong', version: chrome.runtime.getManifest().version };
    sendResponse(pong);
  }
});
