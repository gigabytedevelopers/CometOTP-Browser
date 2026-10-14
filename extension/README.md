# CometOTP browser extension

One TypeScript source, built as a Manifest V3 extension for Chromium (Chrome, Edge, Brave, Opera,
Vivaldi) and for Firefox. For now it is a scaffold: its popup says it is not set up yet, and its
background only answers the popup. Pairing, the vault and the codes come in the next pull requests
([design](../docs/design.md), §10).

## Building

```bash
npm ci
npm run build --workspace @cometotp/protocol
npm run build --workspace @cometotp/extension
```

That writes, under `extension/dist/`:

| Path | What it is |
| --- | --- |
| `chromium/`, `firefox/` | Each build unpacked, to load into the browser for testing. |
| `cometotp-chromium-<version>.zip`, `cometotp-firefox-<version>.zip` | The same files, zipped for the stores. |

Nothing is bundled or minified: the scripts in the zips are what `tsc` wrote, so store reviewers
can read them as they are. The zips are deterministic, so the same source always gives the same
bytes. Browsers cannot resolve package names, so once the extension imports
`@cometotp/protocol`, the build copies that package into `lib/protocol/` and points the imports
there.

To try a build by hand:

- **Chrome:** `chrome://extensions` → turn on **Developer mode** → **Load unpacked** →
  `extension/dist/chromium`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → any file in
  `extension/dist/firefox`.

## How the two builds differ

Only in `manifest.json` (`tools/manifest.ts`):

- **Chromium** runs the background as a module service worker and needs Chrome 120 or later.
- **Firefox** runs it as module background scripts, and needs Firefox 140 or later (the extended
  support release that knows `data_collection_permissions`). Its id is
  `cometotp@gigabytedevelopers.com`, which cannot change once the extension is on
  addons.mozilla.org. It declares that no data is collected: nothing leaves the browser except to
  the relay, which is how the extension works.

## Permissions

None yet. `ALLOWED_PERMISSIONS` in `tools/manifest.ts` lists the ones the extension may request,
and the package check refuses a build that asks for anything else, host permissions included.
Each permission is shown to people when they install, so each one added has to be argued for in
its pull request. The relay needs no host permission: it allows any origin (protocol §6.1).

The pages' content security policy allows only the extension's own scripts: nothing inline,
nothing remote, no `eval`.

## Checks

```bash
npm test --workspace @cometotp/extension       # builds, then runs the tests
npm run lint --workspace @cometotp/extension   # checks the built packages
npm run load-test --workspace @cometotp/extension
```

- **Typecheck:** `tsc` with strict settings, unused code and missing returns included. The browser
  APIs used are declared by hand in `src/chrome.d.ts`, so the list shows what the extension
  touches and no types package is needed.
- **Tests** (`test/`): the manifests, the zip writer (read back by a reader written from the
  format's description), and what each package holds.
- **Package check** (`tools/check.ts`), the extension's lint. It checks that the manifest asks for no
  permission outside `ALLOWED_PERMISSIONS`, keeps the content security policy, and names only
  files that exist. It also checks that pages run no inline script or handler and load nothing
  from elsewhere, and that scripts use no `eval`, string timers, `document.write` or HTML injection
  and import only files in the package.
- **Load test** (`tools/load-test.ts`): loads each build into a real browser, in a throwaway profile,
  and waits for its popup to reach its background. Chrome is driven through the DevTools protocol
  (`Extensions.loadUnpacked`), Firefox through WebDriver BiDi (`webExtension.install`). A browser
  that is not installed is skipped, except in CI, which runs both.

There is no ESLint: TypeScript's strict checks and the package check cover what matters here,
and the repository adds no dependency it can do without.
