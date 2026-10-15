# CometOTP browser extension

One TypeScript source, built as a Manifest V3 extension for Chromium (Chrome, Edge, Brave, Opera,
Vivaldi) and for Firefox. It has its own lock (a password set on first use, and optionally a
passkey), pairs with CometOTP on a phone, and keeps an encrypted, read-only copy of the services
the phone shares. It shows their codes in its popup and, once turned on, fills them into sign-in
pages. Its settings page holds the rest, Disconnect included ([design](../docs/design.md), §10).

## The codes

Once paired and unlocked, the popup lists the copy's services in the phone's order
(`src/popup/codes.ts`): each one's badge, issuer and label, its current code grouped as CometOTP
groups it, and a bar for the time it has left, which turns red for the last five seconds. Codes
are computed in the browser by the protocol package (§5: TOTP and Steam), and each is recomputed
as its period turns. Clicking a row copies its code. A search box filters by issuer, label or tag,
ignoring case and accents. Below the list it says how long ago the phone sent the copy, and from
which phone. Rows are built with DOM calls, never from HTML, as every name comes from the vault.

Codes are only as good as the clock: each answer from the relay carries its time, and when this
computer's clock is more than 30 seconds off, the popup says so and how to fix it.

## Filling codes into sites

**Fill codes into sites** on the settings page turns on a CometOTP button in one-time-code
fields. Turning it on asks the browser for access to sites, which it words as reading and changing
all your data on all websites; nothing is asked at install, and **Turn off** (or the browser's own
settings for the extension) takes it back. Only https sites are covered, and http on this computer
for testing.

- **Which fields** (`src/fill/detect.ts`): those marked `autocomplete="one-time-code"`, and those
  whose name, label or placeholder says so ("otp", "MFA code", "Authentication code"…), or say
  "code" and take digits. Codes sent by text or email, recovery codes, coupons, postal codes and
  card codes are left alone, as are fields that say they are something else. A row of five to eight
  one-character boxes counts too, and gets one character per box.
- **The button** appears at the end of such a field while it is focused (`src/fill/field.ts`). It
  and the menu sit in a closed shadow root, styled through the CSS object model, so page styles
  and strict content security policies leave them alone. Only a person's click opens the menu.
- **The menu** is an extension page in a frame (`src/fill/menu.ts`), so the page sees neither the
  services nor any secret: only the code, once chosen, in the field the menu was opened for. It
  lists the services filled on this site before, then those whose issuer is the site's own name
  ("GitHub" on github.com, not on github.evil.com), and finds the rest by search. It holds names
  only: the background computes the code of the service chosen, links the service to the site
  (sealed under the local key with the rest of the pairing) and sends the code to the field's
  frame. So the frame never holds the local key, and needs no storage of its own, which Firefox
  partitions for frames in other sites' pages.
- **A service linked to other sites** is never listed elsewhere. Found by search, it is filled only
  once the person confirms, as a site can pose as another to get its code.
- **Frames:** codes go into the top page, or a frame from the same host or one within it
  (`auth.example.com` on `example.com`). That is narrower than the same site, which would need the
  public suffix list. The background decides from what the browser says about the frame and its
  tab, never from what a page says, and gives each menu a random name that only the extension's
  menu page in that tab can claim, once (`src/fill/menus.ts`).

## Keeping the copy current

The extension downloads the vault (protocol §7.2, `src/sync/sync.ts`) when the browser starts,
every 15 minutes, and each time the popup opens. Each request carries the version it has, so an
unchanged vault costs one small answer (`304`). A newer version replaces the copy only if its
version is higher than the one accepted, it opens with the vault key, and its payload is one this
extension reads. The vault key is under the lock, so a version downloaded while locked is kept
aside, still sealed, and checked at the next unlock.

What the popup says when something is wrong:

| What happened | What it says |
| --- | --- |
| The relay sent an older version than the one accepted | It was ignored, and the relay may be holding back updates. |
| The vault does not open, or is not a vault | It was ignored; the codes are the ones from before. |
| The payload is in a newer format | Update the extension. |
| The relay no longer knows this browser (`401`, `404`) | Remove it in CometOTP, then pair again. The copy is kept. |
| The relay cannot be reached for 30 minutes | The codes are from the last copy downloaded. |
| The phone removed this browser (`410`) | It was disconnected: everything the pairing kept is deleted. |

## Settings

The settings page (`settings/settings.html`, `src/settings/`) opens in a tab, from **Settings** in
the popup or from the browser's own menu for the extension. A tab, unlike the popup, stays open
while Firefox shows the passkey and permission prompts.

- **This browser:** what it is paired with and since when, and the relay it uses.
- **Name:** the name the phone shows when pairing, such as "Chrome on macOS" unless the person
  chooses another, in at most 64 bytes as the pairing code carries it. The phone keeps the name it
  was given: renaming a paired browser happens in CometOTP, in Connected extensions.
- **Disconnect** (protocol §7.2) deletes the vault on the relay with the read token, then
  everything the pairing kept here (its details, the copy and the sites filled), even when the
  relay cannot be reached. The phone gets `410` at its next upload and stops listing the browser.
  If the relay could not be reached, the page says to remove the browser on the phone too. The
  password and the settings stay, to pair again.
- **Lock after** 1, 5, 15 (the default), 30 or 60 minutes, or 4 hours without input. The
  background applies it each time it starts, and the page at once.
- **Change the password,** given the current one. M stays the same and is sealed again under a key
  from the new password and a new salt, so nothing sealed under M changes, and a passkey keeps
  working. It works locked or unlocked.
- **Passkey:** add, replace or remove one. Adding seals M, so it needs the extension unlocked.
- **Fill codes into sites:** on and off (see above).

## Pairing

**Pair with your phone** in the popup opens a tab (`pair/pair.html`), which stays open while you
use your phone. It does the browser's side of protocol §3.4 (`src/pair/pairing.ts`):

1. It makes a pairing channel on the relay and shows its code as a QR code, with a new one each
   time it expires unanswered (two minutes).
2. When CometOTP scans it and says hello, it checks the hello and shows the six digits and the
   phone's name: **My phone shows the same code** or **Cancel**. It watches for the phone
   cancelling meanwhile.
3. On the confirm, it waits for the phone to send the vault's details. It keeps them as
   protocol §8 says, then says done and downloads the vault, checking that it opens.

Every failure says what happened and what to do: the relay cannot be reached, someone cancelled
on either side, it took too long, or a message could not be verified, which may mean someone else
scanned the code. Nothing is kept unless the pairing finishes.

**The relay** is the official one, `https://relay.gigabytedevelopers.com`, unless you choose your
own under the code ([running your own](../docs/self-hosting.md)). Its address goes to the phone in
the code. http is accepted for this computer and the local network, for testing; CometOTP accepts
it only in its debug builds.

The QR code is drawn by [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
2.0.4 (MIT), whose published ES module build is copied in unchanged, its licence in its header,
under `lib/qrcode-generator/`.

## The lock

The extension keeps everything private sealed under a random 32-byte local key M, with AES-256-GCM
([protocol §8](../docs/protocol.md#8-storage-in-the-browser-informative), `src/lock/`):

- **On disk (IndexedDB):** M sealed under a key from Argon2id over the password (64 MiB, 3 passes,
  a random 16-byte salt; the password NFC-normalized), and later whatever is sealed under M.
  Without the password, nothing there opens, and each guess costs 64 MiB and three passes.
- **While unlocked:** M in `storage.session`, which is in memory only, closed to content scripts,
  and cleared when the browser quits.
- **Locking** takes M out of memory: after 15 minutes without input (or the time chosen in the
  settings), when the computer locks
  (Firefox does not report this, so there the idle time applies), when the browser quits, and
  with **Lock now**.
- **Setup** asks for at least 10 characters and a password the meter rates at least fair. The
  meter is a rough estimate (`src/lock/strength.ts`): it catches common passwords and their
  usual variants, repeats and runs.
- **Forgot the password?** **Reset the extension** forgets it and everything the extension keeps.
  The phone keeps everything, so the browser is paired again afterwards.
- **A passkey** can unlock instead of the password: Touch ID, Windows Hello, a phone or a security
  key (`src/lock/passkey.ts`). The extension asks it, with the person verified, for its WebAuthn
  PRF output on a fixed input, and seals a second copy of M under a key from that output (HKDF).
  Only the authenticator can produce it; nothing is sent anywhere. The relying party is the
  extension itself (no RP ID is given, so no host permission is needed). The option appears only
  where the browser reports PRF support, and the password always keeps working. It is added on
  the settings page. To unlock with it in Firefox, which closes extension popups when the passkey
  prompt appears (Mozilla bug 2026687), the popup opens a tab.

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
imports into `lib/` and points the imports there: `@cometotp/protocol`, and the published builds
of hash-wasm and qrcode-generator, unchanged.

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
| `alarms` | To download the vault every 15 minutes, as the background does not stay running. |
| `idle` | To lock after 15 minutes without input, and when the computer locks. |
| `scripting` | To run the content script for filling codes, once access to sites is granted. |
| `storage` | For `storage.session`, which holds the local key in memory while unlocked. |

None shows a warning when installing. The relay needs no host permission: it allows any
origin (protocol §6.1).

Access to sites is an optional host permission (`OPTIONAL_HOSTS`): https sites, and http on this
computer for testing. The extension asks for it only when someone turns on filling codes into
sites, and the background runs the content script exactly while it is granted.

Pages may load four files from the extension (`WEB_ACCESSIBLE`): the content script's three
modules, which a content script imports from the page's side, and the menu page. So a page can
tell that the extension is installed, and nothing more.

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
  format's description), what each package holds, the lock's cryptography, the strength estimate,
  the browser's name, how the popup writes codes and times, which downloaded vaults may replace
  the copy, which fields get the button (fields modelled on GitHub's, Google's, Microsoft's,
  AWS's and Amazon's sign-in pages, and fields that only look like them), which sites and frames
  may be filled and what the menu offers there, the settings' choices (lock times, and names the
  pairing code can carry), a new password around the same local key, and pairing. Pairing runs
  against a relay kept in memory and a phone that does its side with the protocol package: the
  happy path, a code that expires unanswered, and every way it can fail.
- **Package check** (`tools/check.ts`), the extension's lint. It checks that the manifest asks for no
  permission outside `ALLOWED_PERMISSIONS`, for access to sites only as `OPTIONAL_HOSTS`, exposes
  to pages only `WEB_ACCESSIBLE`, keeps the content security policy, and names only files that
  exist. The content script's modules must import only modules pages may load. It also checks
  that pages run no inline script or handler and load nothing from elsewhere, and that scripts use
  no `eval`, string timers, `document.write` or HTML injection and import only files in the
  package.
- **Load test** (`tools/load-test.ts`): loads each build into a real browser, in a throwaway profile,
  and waits for its popup to reach its background. Then it uses the lock through the popup: it
  sets a password, checks that the local key is only in memory and that the record on disk holds
  neither it nor the password, locks and reloads, tries a wrong password, and unlocks again to
  the same key. In Chrome it then attaches a virtual authenticator with PRF, adds a passkey on
  the settings page, and unlocks with it in the popup to the same key; an authenticator without
  PRF is refused, and the password still works. WebDriver BiDi has no virtual authenticator yet,
  so in Firefox it only checks whether passkeys are offered. On the settings page it chooses a
  lock time (the popup must then say it), names the browser (the stand-in phone below checks the
  name in the pairing code), and changes the password: a wrong current one is refused, the old
  one stops unlocking and the new one unlocks to the same key, with the passkey kept. Then, in
  both browsers, it starts the relay from this repository
  and pairs through it with a stand-in phone that reads the code from the page. It checks the
  six digits, uploads a vault and finishes. The page must end paired with that vault's service,
  and the vault key must be kept sealed. The popup must then show that service's code as the
  protocol package computes it. The phone adds a Steam service and uploads again, and the popup
  must show both codes. Last, the phone deletes the vault, and the popup must say it removed the
  browser, with the pairing and the copy gone. Before that, it fills codes into a page it serves
  under a strict content security policy: the code field gets the button and the email field does
  not; the menu finds the service by search and fills the field with its code; six one-digit
  boxes get a digit each from the service, now linked and offered first; a frame from the same
  host gets the button and one from another host does not; Escape closes the menu. Neither
  browser, driven this way, can answer the prompt for access to sites or click in the popup as a
  person would, so both load a copy of the build that has access already. In Firefox, which lets
  an extension give such access back, **Turn off** must then remove the button. Last, it pairs
  again and disconnects from the settings page: the pairing, the copy and the site links must be
  gone, and the stand-in phone's next upload must get `410`. Chrome is driven through the
  DevTools protocol (`Extensions.loadUnpacked`), Firefox through WebDriver BiDi
  (`webExtension.install`). A browser that is not installed is skipped, except in CI, which runs
  both.

There is no ESLint: TypeScript's strict checks and the package check cover what matters here,
and the repository adds no dependency it can do without.
