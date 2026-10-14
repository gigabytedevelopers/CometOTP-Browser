// The popup. Until pairing exists it only says so, with the version, and pings the background:
// once the background answers, the page records its version in `data-background`, which the load
// test waits for (tools/load-test.ts).
import { isPong } from '../messages.js';

const version = chrome.runtime.getManifest().version;
const versionLine = document.getElementById('version');
if (versionLine) versionLine.textContent = `Version ${version}`;

chrome.runtime.sendMessage({ type: 'ping' }).then(
  (reply) => {
    if (isPong(reply)) document.body.dataset.background = reply.version;
  },
  () => {
    document.body.dataset.background = 'unreachable';
  },
);
