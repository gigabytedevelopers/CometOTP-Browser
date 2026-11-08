// Updating CometOTP from the settings page. A copy from a store updates itself, but on the
// browser's schedule: Chrome checks every few hours and installs once the background is idle,
// Firefox checks about once a day. "Check for updates" asks the store now
// (runtime.requestUpdateCheck); the browser downloads a newer version and says so
// (runtime.onUpdateAvailable), and the page restarts the extension to install it, which locks it as
// quitting the browser does. Firefox has not implemented asking the store, so there the page says
// how to check from its Add-ons Manager instead. A copy loaded from a folder has no store to ask.
// What the page says is worked out here, apart from the page (test/update.test.ts).

export type UpdateState =
  /** From a store, before any check. */
  | { kind: 'idle' }
  /** From a store, in a browser that cannot be asked to check (Firefox). */
  | { kind: 'manual' }
  /** Loaded from a folder: it cannot update itself. */
  | { kind: 'folder' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  /** The browser checked a moment ago, and will not again yet. */
  | { kind: 'throttled' }
  /** A newer version is coming down; the browser says when it is ready. */
  | { kind: 'downloading'; version: string | null }
  /** Ready: the extension restarts to install it. */
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; reason: string };

/** The state an install type starts in, where the browser can (`canCheck`) or cannot ask its store. */
export function startState(installType: chrome.management.ExtensionInfo['installType'], canCheck: boolean): UpdateState {
  if (installType === 'development') return { kind: 'folder' };
  return canCheck ? { kind: 'idle' } : { kind: 'manual' };
}

/** The state after the store answered a check, in Chromium's shape or Firefox's. */
export function checkedState(result: chrome.runtime.UpdateCheck): UpdateState {
  if (result.status === 'no_update') return { kind: 'latest' };
  if (result.status === 'throttled') return { kind: 'throttled' };
  return { kind: 'downloading', version: result.version ?? result.details?.version ?? null };
}

/** What the settings page says in `state`, for version `current`. */
export function updateText(state: UpdateState, current: string): string {
  switch (state.kind) {
    case 'idle':
      return 'Your browser installs new versions of CometOTP on its own, usually within a day. Check now to get one at once.';
    case 'manual':
      return "Your browser installs new versions of CometOTP on its own, about once a day. To update now, open Firefox's Add-ons Manager (about:addons), click the gear button and choose Check for Updates.";
    case 'folder':
      return 'This copy was loaded from a folder, not installed from a store, so it cannot update itself. Install CometOTP from the Chrome Web Store or Firefox Add-ons to get updates.';
    case 'checking':
      return 'Checking for a new version…';
    case 'latest':
      return `CometOTP ${current} is the latest version.`;
    case 'throttled':
      return 'Your browser checked for updates a moment ago. Try again in a few minutes.';
    case 'downloading':
      return (
        `${state.version ? `Version ${state.version}` : 'A new version'} is downloading. CometOTP then restarts to install it ` +
        'and locks, as when the browser quits. If nothing happens within a minute, restart it now.'
      );
    case 'installing':
      return `Installing version ${state.version}: CometOTP restarts and locks, and this page closes. Unlock it again from its button in the toolbar.`;
    case 'failed':
      return `Could not check for updates: ${state.reason}`;
  }
}
