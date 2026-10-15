// The extension's manifest for each browser. Both are Manifest V3 and differ only where the
// browsers do: Chromium runs the background as a service worker, Firefox as background scripts,
// and Firefox needs its own id and data-collection declaration.
import { FILL_SITES } from '../src/fill/sites.js';

/** The browsers the extension is built for, from the same source. */
export type Target = 'chromium' | 'firefox';

export const TARGETS: readonly Target[] = ['chromium', 'firefox'];

/** Firefox's id for the extension. It cannot change once the extension is on addons.mozilla.org. */
export const GECKO_ID = 'cometotp@gigabytedevelopers.com';

/**
 * Permissions the extension may request, each argued for in the pull request that added it, as
 * browsers may show them to people when they install. tools/check.ts refuses a build that asks
 * for anything else. None of these shows an install warning.
 * - alarms: to check for a newer vault every 15 minutes.
 * - idle: to lock after 15 minutes without input and when the computer locks.
 * - scripting: to run the content script for filling codes, once access to sites is granted.
 * - storage: for storage.session, which holds the local key in memory while unlocked.
 */
export const ALLOWED_PERMISSIONS: readonly string[] = ['alarms', 'idle', 'scripting', 'storage'];

/**
 * Access to sites, asked for only when the person turns on filling codes into sites, never at
 * install: the content script needs it to put the CometOTP button in code fields. Browsers word
 * it as reading and changing all sites' data. https only, and http on this computer for testing.
 */
export const OPTIONAL_HOSTS: readonly string[] = FILL_SITES;

/**
 * What pages may load from the extension: the content script's modules, which a content script
 * imports from the page's side, and the menu its button opens in a frame. Nothing else, so pages
 * learn little more than that the extension is installed.
 */
export const WEB_ACCESSIBLE: readonly string[] = ['fill/detect.js', 'fill/field.js', 'fill/menu.html', 'fill/messages.js'];

/**
 * Only the extension's own scripts run on its pages: nothing inline, nothing remote. WebAssembly
 * may be compiled ('wasm-unsafe-eval'), for Argon2id, which WebCrypto does not offer; eval of
 * JavaScript stays forbidden.
 */
export const EXTENSION_PAGES_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'";

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
    options_ui: { page: 'settings/settings.html', open_in_tab: true },
    permissions: [...ALLOWED_PERMISSIONS],
    optional_host_permissions: [...OPTIONAL_HOSTS],
    web_accessible_resources: [{ resources: [...WEB_ACCESSIBLE], matches: [...OPTIONAL_HOSTS] }],
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
