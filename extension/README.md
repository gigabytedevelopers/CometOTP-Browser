# CometOTP browser extension

One TypeScript source, built as a Manifest V3 extension for Chromium (Chrome, Edge, Brave, Opera,
Vivaldi) and for Firefox. So far it has its own lock: a password set on first use, locked and
unlocked from the popup. Pairing, the vault and the codes come in the next pull requests
([design](../docs/design.md), §10).

## The lock

The extension keeps everything private sealed under a random 32-byte local key M, with AES-256-GCM
([protocol §8](../docs/protocol.md#8-storage-in-the-browser-informative), `src/lock/`):

- **On disk (IndexedDB):** M sealed under a key from Argon2id over the password (64 MiB, 3 passes,
  a random 16-byte salt; the password NFC-normalized), and later whatever is sealed under M.
  Without the password, nothing there opens, and each guess costs 64 MiB and three passes.
- **While unlocked:** M in `storage.session`, which is in memory only, closed to content scripts,
  and cleared when the browser quits.
- **Locking** takes M out of memory: after 15 minutes without input, when the computer locks
  (Firefox does not report this, so there the idle time applies), when the browser quits, and
  with **Lock now**.
- **Setup** asks for at least 10 characters and a password the meter rates at least fair. The
  meter is a rough estimate (`src/lock/strength.ts`): it catches common passwords and their
  usual variants, repeats and runs.
- **Forgot the password?** **Reset the extension** forgets it and everything the extension keeps.
  The phone keeps everything, so the browser is paired again afterwards.

Argon2id comes from [hash-wasm](https://github.com/Daninet/hash-wasm) 4.12.0 (MIT), as
WebCrypto has none: its published ES module build is copied into the extension unchanged, with
its licence, under `lib/hash-wasm/`. It runs as WebAssembly, which the content security policy
allows ('wasm-unsafe-eval'); eval of JavaScript stays forbidden. The tests check it against the
reference implementation's test vector and against keys from Node's own Argon2id.

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
bytes. Browsers cannot resolve package names, so the build copies the packages the extension
imports into `lib/` and points the imports there: `@cometotp/protocol`, and hash-wasm's published
build, unchanged.

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

`ALLOWED_PERMISSIONS` in `tools/manifest.ts` lists the ones the extension may request, and the
package check refuses a build that asks for anything else, host permissions included. Browsers
may show them to people when they install, so each one is argued for in the pull request that
adds it:

| Permission | Why |
| --- | --- |
| `idle` | To lock after 15 minutes without input, and when the computer locks. |
| `storage` | For `storage.session`, which holds the local key in memory while unlocked. |

Neither shows a warning when installing. The relay needs no host permission: it allows any
origin (protocol §6.1).

The pages' content security policy allows only the extension's own scripts, and WebAssembly for
Argon2id: nothing inline, nothing remote, no `eval` of JavaScript.

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
  format's description), what each package holds, the lock's cryptography and the strength
  estimate.
- **Package check** (`tools/check.ts`), the extension's lint. It checks that the manifest asks for no
  permission outside `ALLOWED_PERMISSIONS`, keeps the content security policy, and names only
  files that exist. It also checks that pages run no inline script or handler and load nothing
  from elsewhere, and that scripts use no `eval`, string timers, `document.write` or HTML injection
  and import only files in the package.
- **Load test** (`tools/load-test.ts`): loads each build into a real browser, in a throwaway profile,
  and waits for its popup to reach its background. Then it uses the lock through the popup: it
  sets a password, checks that the local key is only in memory and that the record on disk holds
  neither it nor the password, locks and reloads, tries a wrong password, and unlocks again to
  the same key. Chrome is driven through the DevTools protocol
  (`Extensions.loadUnpacked`), Firefox through WebDriver BiDi (`webExtension.install`). A browser
  that is not installed is skipped, except in CI, which runs both.

There is no ESLint: TypeScript's strict checks and the package check cover what matters here,
and the repository adds no dependency it can do without.
