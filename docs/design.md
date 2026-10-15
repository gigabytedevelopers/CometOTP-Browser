# Browser extension companion: design

**Status:** revised 12 October 2026. No code yet.

**Decided:** the browser keeps its own copy of the services (no "ask my phone" mode); every service
is shared once a browser is paired; the browser unlocks with a password or a passkey; sync goes
through a relay. See [§9](#9-decisions) for the rest and [§10](#10-pr-plan) for the PR plan.

**Goal:** CometOTP's codes in a browser on a computer, also when the phone is not there. The phone
pairs with the extension once and from then on keeps an end-to-end-encrypted copy of its services
up to date through a relay. The extension computes codes itself, shows them in its popup and fills
them into sites.

**The trade-off, accepted:** the secrets themselves leave the phone. A computer that also stores
the user's passwords then holds both factors, and removing a browser stops updates but cannot take
back what it already has (§6). The app says so before the first pairing.

---

## 1. What is shared

- **Every TOTP and Steam service**, unless its **Browser extension** switch is off. The switch is
  on by default, so new services are shared on the next sync.
- **Never HOTP or mOTP.** A one-way copy cannot keep an HOTP counter in step: phone and browser
  would hand out the same counter value, or drift past the server's window. mOTP needs its PIN
  typed at use. The switch is shown disabled for these, with the reason.
- **Per service:** secret, issuer, label, type, algorithm, digits, period, initials, badge colour,
  icon name and tags. Not usage counts or last-used times.
- **The browser is read-only.** It cannot add, edit or delete services, so there are no sync
  conflicts and a compromised browser cannot plant entries on the phone.

---

## 2. Pairing

| Purpose | Choice | Why |
| --- | --- | --- |
| Key agreement | ECDH on P-256, ephemeral keys | Built into Android at minSdk 24 and into WebCrypto in every browser; X25519 would need Tink or Bouncy Castle below API 33. |
| Key derivation | HKDF-SHA256 | WebCrypto has it; ~20 lines over `HmacSHA256` on Android. |
| Encryption | AES-256-GCM | Native on both sides. |
| Confirmation | 6-digit short authentication string (SAS) | Catches a leaked or raced QR code. |

```
Extension                                   Relay                      Phone (CometOTP, unlocked)
ephemeral key pair E, one-time secret s,
pairing channel c
QR: cometotp://pair?v=1&r=<relay>&c=<c>&k=<E_pub>&s=<s>&n=<browser name>
                                                                       scans QR (needs a lock)
                                                                       ephemeral key pair P
                                            <-- hello: P_pub, sealed with K
K = HKDF(ECDH(E,P) ‖ s, transcript)                                    same K
"Check your phone shows 135 557"                                       "Does your browser show
[My phone shows the same code]                                         135 557?"  [Pair] [Cancel]
                                            -- confirm -->
                                                                       new random vault key V,
                                                                       vault id, write token W,
                                                                       read token R; uploads v1
                                            <-- vault: {id, R, V}, sealed with K
stores V, id, R; discards E and K           -- done -->                discards P and K
```

- The camera reads `E_pub` and `s` straight off the screen. `s` goes into the key derivation, so a
  hello that opens proves it came from whoever scanned the code. The QR and channel are single-use
  and expire after 2 minutes, only one phone can answer a channel, and the person confirms the SAS
  on both screens.
- **V is random and never derived from the PIN or password.** The relay only ever holds data
  encrypted with V, so a copy of it cannot be attacked by guessing.
- Each browser gets its own V, vault and tokens, so removing one never touches the others.

---

## 3. Sync through the relay

The phone writes, the browser reads. Neither needs the other to be online.

**Relay API:** pairing channels (`/v1/pair/{c}`, with one message queue per direction), and
vaults: `POST /v1/vaults` to create, `PUT /v1/vault/{id}` (phone, W) to upload a higher version,
`GET /v1/vault/{id}` (browser, R, with an ETag so an unchanged vault costs a `304`) and `DELETE`
(either) to unpair. The full API is in the protocol spec (`docs/protocol.md`).

The relay stores, per vault: the id, hashes of W and R, the version, the blob, and the date it was
last read (day precision). It keeps no request logs with IP addresses. Vaults not read for 180
days are deleted.

**Blob:** AES-256-GCM under V of `{version, services[]}`, with the vault id and version as
associated data, padded to a multiple of 4 KB so its size does not reveal the number of services.
The extension remembers the highest version it has seen and rejects anything older, so the relay
cannot roll a browser back to a vault from before a service was removed.

**When the phone uploads:** after pairing, and after any change to the services or their switches.
Changes only happen while CometOTP is unlocked, so the vault is always built with the database key
in hand. A failed upload is retried by WorkManager with the blob already encrypted, needing no key.

**When the browser checks:** at browser start, on unlock, when the popup opens, and every 15
minutes (`chrome.alarms`).

**No push service:** nothing ever has to wake the phone, so there is no Firebase and no Google
dependency, and a self-hosted relay works exactly like the official one. The relay URL travels in
the pairing QR.

---

## 4. In the browser

- **At rest:** IndexedDB holds the blob exactly as downloaded, and a random local key M that
  encrypts V and everything else private, itself wrapped twice:
  - by a key from **Argon2id over the extension password** (WebAssembly; WebCrypto has no
    memory-hard KDF), and
  - by a key from a **passkey** through the WebAuthn PRF extension (Touch ID, Windows Hello, a
    phone or a security key), where the browser and authenticator support PRF.
- **Setup:** before the first pairing the extension asks for its own password (minimum length and
  a strength meter) and offers to add a passkey. The password always works; the passkey is the
  quick way, as biometrics are on top of the PIN in the app.
- **Unlocked:** M lives in `storage.session`, which stays in memory, is cleared when the browser
  quits and is not readable by content scripts. It survives the MV3 service worker being stopped.
- **Auto-lock:** after 15 idle minutes (configurable), when the computer locks (`idle` API) and
  when the browser quits.
- **Popup:** services with search, the current code and its countdown; click to copy.
- **Filling:** once the person turns it on, which asks the browser for access to sites (never at
  install), a small CometOTP button in one-time-code fields lists the services linked to the
  site first, then issuer matches; choosing one fills its code into that field and links the site
  for next time (links are stored encrypted with M). Content scripts only ever receive a code,
  never a secret. Codes go only into the field the user chose, in the top frame or a same-site
  frame.
- **Clock:** codes depend on the computer's clock; the extension warns when it differs from the
  relay's `Date` header by more than 30 seconds.

---

## 5. In the app

- **Edit sheet** (ManualEntryDialog / `sheet_create_service.xml`), under Other settings: a
  **Browser extension** switch, "Show this service's codes in connected browsers", on by default
  and saved in the entry JSON only when off (like `initials` and `badge_color`). Turning it off
  removes the service at the next sync, with a note that a browser may keep a copy it already had.
- **Settings → Security → Connected extensions:** each browser with its name (renamable), when it
  was paired and when it last synced; **Pair a browser** (needs a lock) opens the existing
  full-screen scanner, then the SAS check, then a one-time explanation of what is shared and that
  it cannot be taken back. Tapping a row offers **Remove**.
- **Pairing data** (vault ids, V, W, names) lives in a new `browsers.dat`, encrypted with the
  **database key**, so it has the same protection as `secrets.dat`. It is re-encrypted when the
  encryption changes (EncryptionChangeHelper), excluded from backups and device transfer, and
  deleted by the panic response and database wipes.
- ScreenshotGuard on the pairing and Connected extensions screens.

---

## 6. Unpairing

- **From the phone:** Remove deletes the vault on the relay and the row in `browsers.dat`. At its
  next check the extension gets `410`, wipes its copy and says it was disconnected. The app then
  lists the services that browser had, with advice: if the computer was lost or stolen, reset 2FA
  at these services.
- **From the browser:** Disconnect wipes the extension's data and deletes the vault. The phone gets
  `410` at its next upload, removes the row and says so.
- **Panic response and wipes:** delete `browsers.dat`; vault deletions are queued and sent when
  the network allows.
- **Lock removed:** syncing pauses (no uploads, the list says why); browsers keep what they had,
  and setting a lock again resumes syncing.
- **Removing is not revoking.** A browser that is offline, compromised or stolen keeps what it had.
  Only resetting 2FA at a service makes its old secret worthless.

---

## 7. Threat model

**Assets:** the OTP secrets; the unlocked browser copy; metadata (that the user has a vault, when
it changes, when and from where the browser checks it).

| Adversary | Can | Cannot / mitigation |
| --- | --- | --- |
| Relay operator or network | See vault ids, padded sizes, when the phone uploads and the browser checks, and IP addresses; withhold updates or delete vaults. | Read or forge vaults (V never reaches it); roll a browser back (versions). No IP logs; self-hosting removes this party. |
| Someone who saw the pairing QR | Race the real phone to pair. | Succeed silently: one-time QR, 2-minute expiry, SAS check. The QR carries no vault key. |
| Thief of the locked computer | Copy the browser profile. | Read it without the extension password or passkey: Argon2id makes guessing slow, so this depends on the password's strength. |
| Malware on the computer while unlocked | Read every shared secret, and passwords stored in the browser. | This is the accepted cost. Auto-lock shortens the window; switching a service off keeps it phone-only. |
| Another extension or a web page | See codes filled into pages, as with typing. | Read the extension's storage, or receive secrets: content scripts never hold them. |
| Phishing site | Show a fake code field. | Get a code without the user choosing a service; linked services only appear on their own sites. |
| Thief of the phone | Nothing new. | Read `browsers.dat` without unlocking CometOTP. |
| Out of scope | A compromised OS on either device. | |

**Housekeeping:** the privacy policy (`assets/www/privacy_policy.html`) and Play's Data safety form
must say that encrypted copies of secrets are stored on a relay; the Chrome Web Store and Firefox
listings need their own privacy disclosures.

---

## 8. Browsers and source location

- **Chrome/Chromium, Manifest V3:** Chrome, Edge, Brave, Opera, Vivaldi.
- **Firefox (MV3)** from the same TypeScript source as a second build target.
- **Safari** later, if ever: it needs an Xcode wrapper app and an Apple developer account.

Recommended: a **new repository** for the extension, the relay and the protocol specification with
test vectors. CometOTP's master ruleset requires the four Android CI checks on every pull request,
and path-filtered checks that never report leave PRs stuck. The Android repo keeps a copy of the
test vectors so its crypto tests run in its own CI.

---

## 9. Decisions

1. **Lock:** pairing needs a CometOTP lock (`requireLock`). Turning the lock off pauses syncing;
   setting one again resumes it.
2. **Repository:** a new one for the extension, the relay and the protocol spec.
3. **Browsers:** Chromium and Firefox in the first release, from one source.
4. **Relay:** a small TypeScript server with SQLite, shipped as a Docker image; the official
   instance runs on a small VPS, and anyone can self-host the same image.
5. **Access to sites:** asked for only when the person turns on filling codes into sites, so
   installing shows no warning; until then, nothing of the extension runs on any site.

---

## 10. PR plan

### Accounts and hosting (yours to do)

- Done: the repository is `gigabytedevelopers/CometOTP-Browser` (MIT, default branch `main`), and
  Princess has write access.
- A VPS and a domain for the official relay (for example `relay.<your domain>`), with HTTPS.
- Chrome Web Store developer account (one-time $5) and a Firefox Add-ons account (free); Edge
  Add-ons is optional and free.

Every change, the bootstrap (B0) included, goes through a pull request reviewed by Princess and is
merged locally with a fast-forward. Progress is tracked on the
[project board](https://github.com/orgs/gigabytedevelopers/projects/3).

### New repository

| PR | Change | Notes |
| --- | --- | --- |
| B0 | Bootstrap: README, ignore rules, review-request workflow, CODEOWNERS, pull request template, ruleset, RELEASING.md | Then import the ruleset; its required checks are the CI job names. |
| B1 | Protocol spec and test vectors | Pairing messages, HKDF labels, SAS, vault blob and padding, relay API, error codes. Every later PR on both sides tests against these vectors. |
| B2 | Shared TypeScript protocol package | ECDH, HKDF, AES-GCM, SAS, blob encode/decode, version checks; tests against B1. |
| B3 | Relay server | Pairing channels, vault endpoints, token hashes, version rule, rate limits, 180-day clean-up, no IP logs; SQLite; tests. |
| B4 | Relay Docker image and self-hosting guide | CI builds the image; release workflow publishes it to GHCR. Deploy the official instance after this. |
| B5 | Extension scaffold | MV3 manifests for Chromium and Firefox, build producing two zips, empty popup; CI packages both. |
| B6 | Extension vault and password lock | Password setup with strength meter, Argon2id (WebAssembly), V wrapping, IndexedDB, `storage.session`, auto-lock on idle, screen lock and quit. |
| B7 | Passkey unlock | WebAuthn PRF, with feature detection; hidden where unsupported. |
| B8 | Pairing screen | QR, pairing channel, SAS, storing the vault credentials. |
| B9 | Sync and codes in the popup | Fetch with ETag, rollback check, TOTP and Steam (RFC 6238 vectors), list, search, copy, countdown, clock warning, `410` handling. |
| B10 | Filling into sites | One-time-code field detection, field button, site links, fill into the chosen field only. |
| B11 | Extension settings and Disconnect | Auto-lock time, relay shown, rename, Disconnect. |
| B12 | Store listings, privacy disclosures and release workflow | Signed tags, zips attached to GitHub releases; store uploads by hand at first. |

### CometOTP (this repository)

Each PR is split into commits by logical change, tested on your Samsung dev build (data backed up
and restored byte for byte) and on the Pixel 7 emulator. Until A8 the Connected extensions entry
is shown in **debug builds only**, so a release cut in between ships nothing half-built.

| PR | Change | Notes |
| --- | --- | --- |
| A1 | Sync crypto | HKDF, P-256 ECDH, AES-GCM, SAS, pairing and vault codecs; unit tests with a copy of the B1 vectors. No UI. |
| A2 | Browser extension switch | Entry JSON field (saved only when off), disabled with a reason for HOTP and mOTP; row in the edit sheet. Inert until A4. |
| A3 | `browsers.dat` | Encrypted with the database key; re-encrypted on encryption change; excluded in `backup_rules.xml` and `data_extraction_rules.xml`; deleted by panic and wipes. |
| A4 | Relay client and uploads | `HttpURLConnection` client; build, pad and encrypt the vault after each save; WorkManager retries; `410` removes the row; pause without a lock. A debug-only network security config allows a local relay over HTTP for testing. |
| A5 | Connected extensions screen | In Settings → Security: list, rename, Remove (deletes the vault, then lists the services that browser had, with the reset-2FA advice), empty state, ScreenshotGuard. |
| A6 | Pair a browser | `requireLock`, the existing full-screen scanner accepting `cometotp://pair` codes, SAS check, one-time explanation, first upload. |
| A7 | Privacy policy and FAQ | Privacy policy covers the relay; a FAQ entry on using codes in a browser. |
| A8 | Release | Shows the entry in release builds; version bump and Play "What's new". Merged only after the extension is live in the stores. Update Play's Data safety form at the same time. |

**Order:** B0 → B1, then B2 with A1 and A2 in parallel; B3 and B4, then A3 to A6 against a relay
running in Docker on the Mac (the phone reaches it on the LAN, the emulator at `10.0.2.2`); B5 to
B11 alongside; end-to-end test; then B12, A7 and A8.
