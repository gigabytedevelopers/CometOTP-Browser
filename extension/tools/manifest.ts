// The extension's manifest for each browser. Both are Manifest V3 and differ only where the
// browsers do: Chromium runs the background as a service worker, Firefox as background scripts,
// and Firefox needs its own id and data-collection declaration.

/** The browsers the extension is built for, from the same source. */
export type Target = 'chromium' | 'firefox';

export const TARGETS: readonly Target[] = ['chromium', 'firefox'];

/** Firefox's id for the extension. It cannot change once the extension is on addons.mozilla.org. */
export const GECKO_ID = 'cometotp@gigabytedevelopers.com';

/**
 * Permissions the extension may request. Empty until a feature needs one: each one added is shown
 * to people when they install, so it has to be argued for in its pull request. tools/check.ts
 * refuses a build that asks for anything else, host permissions included.
 */
export const ALLOWED_PERMISSIONS: readonly string[] = [];

/** Only the extension's own scripts run on its pages: nothing inline, nothing remote. */
export const EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'none'; base-uri 'none'";

/** The Chrome Web Store refuses longer descriptions. */
export const MAX_DESCRIPTION = 132;

const ICONS = {
  '16': 'icons/icon-16.png',
  '32': 'icons/icon-32.png',
  '48': 'icons/icon-48.png',
  '128': 'icons/icon-128.png',
};

export function manifest(target: Target, version: string): Record<string, unknown> {
  const common = {
    manifest_version: 3,
    name: 'CometOTP',
    version,
    description: 'Your CometOTP two-factor codes in your browser, even when your phone is not with you.',
    icons: ICONS,
    action: {
      default_title: 'CometOTP',
      default_popup: 'popup/popup.html',
      default_icon: { '16': ICONS['16'], '32': ICONS['32'] },
    },
    content_security_policy: { extension_pages: EXTENSION_PAGES_CSP },
  };
  if (target === 'chromium') {
    return {
      ...common,
      background: { service_worker: 'background.js', type: 'module' },
      minimum_chrome_version: '120',
    };
  }
  return {
    ...common,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        // 140 is the extended support release that knows data_collection_permissions.
        strict_min_version: '140.0',
        // Nothing leaves the browser except to the relay, which is how the extension works.
        data_collection_permissions: { required: ['none'] },
      },
    },
  };
}
