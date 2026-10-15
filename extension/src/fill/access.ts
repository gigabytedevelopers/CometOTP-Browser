// Access to sites, which the person turns on for the CometOTP button in code fields. Installing
// asks for nothing; the popup asks the browser for FILL_SITES, and the background registers the
// content script whenever they are granted and removes it when they are not. So it does not
// matter where the request was made: Firefox closes the popup while it asks.
import { FILL_SITES } from './sites.js';

const SCRIPT_ID = 'fill';
const CONTENT_SCRIPT = 'fill/content.js';

export function hasSiteAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [...FILL_SITES] });
}

/** Asks the browser for access to sites. Call it straight from a click: browsers ask only then. */
export function requestSiteAccess(): Promise<boolean> {
  return chrome.permissions.request({ origins: [...FILL_SITES] });
}

export function removeSiteAccess(): Promise<boolean> {
  return chrome.permissions.remove({ origins: [...FILL_SITES] });
}

let updating: Promise<void> = Promise.resolve();

/**
 * Registers the content script when access is granted, and unregisters it when not. With
 * `openTabs`, it also runs the script in the tabs already open, so a sign-in page open while the
 * person turned it on gets the button without a reload.
 */
export function updateContentScript(openTabs = false): Promise<void> {
  updating = updating.then(async () => {
    const granted = await hasSiteAccess();
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0;
    if (granted && !registered) {
      await chrome.scripting.registerContentScripts([
        { id: SCRIPT_ID, js: [CONTENT_SCRIPT], matches: [...FILL_SITES], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true },
      ]);
    } else if (!granted && registered) {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    }
    if (granted && openTabs) {
      for (const tab of await chrome.tabs.query({ url: [...FILL_SITES] })) {
        if (tab.id === undefined) continue;
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: [CONTENT_SCRIPT] }).catch(() => undefined);
      }
    }
  });
  updating = updating.catch(() => undefined);
  return updating;
}
