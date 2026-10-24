# Store listings

What to enter in the Chrome Web Store, Firefox Add-ons and, if listed there, Microsoft Edge
Add-ons. It lives next to the extension, so a change to the extension that changes what the stores
should say changes it in the same pull request. How a release reaches the stores is in
`.github/RELEASING.md`.

## Both stores

| Field | Value |
| --- | --- |
| Name | CometOTP |
| Summary | Your CometOTP two-factor codes in your browser, even when your phone is not with you. |
| Category | Chrome: Productivity → Tools. Firefox: Privacy & Security. |
| Language | English |
| Homepage | https://github.com/gigabytedevelopers/CometOTP-Browser |
| Support | support@gigabytedevelopers.com, or https://github.com/gigabytedevelopers/CometOTP-Browser/issues |
| Privacy policy | https://github.com/gigabytedevelopers/CometOTP-Browser/blob/main/docs/privacy.md |
| Icon | `icons/icon-128.png` from the package |
| Screenshots | `screenshots/*.png`, 1280 × 800 |

The summary is the manifest's description (`tools/manifest.ts`), which Chrome limits to 132
characters.

### Description

```text
CometOTP shows the two-factor codes from CometOTP on your Android phone in your browser, and can fill them into sign-in pages. Your phone stays where you add and edit services; the browser keeps an encrypted, read-only copy, so your codes are at hand even when your phone is not.

• End-to-end encrypted. You pair by scanning a QR code with your phone and checking that both screens show the same six digits. Your services are encrypted on your phone with a key the relay never sees.

• Locked when you are away. The extension has its own password, and can unlock with a passkey: Touch ID, Windows Hello, your phone or a security key. It locks itself after a time without use, when your computer locks and when the browser quits.

• Fills codes for you. Turn it on in the settings, and a CometOTP button appears in code fields. Choose a service and its code is filled in: the site sees only that code. Services you used on a site are offered there first, and a site posing as another gets nothing without your say-so.

• Always current. A change on your phone shows in your browser when you next open CometOTP there, and within 15 minutes otherwise. Removing the browser on your phone deletes its copy.

• Our relay or yours. Sync goes through a small relay that stores only encrypted data and keeps no IP addresses. You can run your own.

• No ads, no accounts. Usage statistics are off unless you turn them on in the settings, and never include your codes, your services or the sites you use.

• Open source: https://github.com/gigabytedevelopers/CometOTP-Browser

Needs CometOTP for Android, with a lock (a PIN, a password or your screen lock) set.
```

## Chrome Web Store: privacy practices

**Single purpose:** Shows the two-factor codes from the CometOTP app on the person's phone, and
fills them into sign-in pages.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `alarms` | Checks every 15 minutes for a newer encrypted copy of the person's services from their phone. |
| `idle` | Locks the extension after the time without input the person chose, and when the computer locks. |
| `scripting` | Runs the content script that puts a CometOTP button in one-time-code fields, only once the person turns on "Fill codes into sites". |
| `storage` | Keeps the extension's local key in session storage, in memory only, while it is unlocked. |
| Host permissions (optional) | Asked for only when the person turns on "Fill codes into sites". The content script looks for one-time-code fields to put the CometOTP button in them, and fills the code the person chooses. It reads nothing else from pages and sends nothing from them. |

**Remote code:** No. All JavaScript and WebAssembly is in the package. Usage statistics are sent
as plain requests (Google Analytics' Measurement Protocol), not with Google's tag.

**Data usage:**

- Authentication information. The extension keeps an encrypted copy of the two-factor secrets the
  person's phone shares, to show their codes and fill them in. It receives them encrypted from the
  relay and sends them nowhere.
- User activity, only if the person turns on Usage statistics in the settings (off unless they
  do): which of the extension's own features they use (opening the popup, copying or filling a
  code, pairing, disconnecting), with the extension's version, the browser's family and a random
  ID, sent to Google Analytics. Nothing from web pages, and none of their codes, services or sites.

Then the three certifications: not sold or transferred to third parties, not used for purposes
unrelated to the single purpose, and not used to determine creditworthiness or for lending.

## Firefox Add-ons

**Data collection:** none required; technical and interaction data optional, for the usage
statistics the person can turn on in the settings, as the manifest declares
(`data_collection_permissions`). The extension sends them only when both its own setting (off by
default) and Firefox's switch are on.

**Source code:** yes, as TypeScript is compiled to JavaScript. Upload
`cometotp-browser-source-X.Y.Z.zip` from the release.

**Notes to the reviewer:**

```text
Build: Node.js 22 or later, any operating system.
  npm ci --ignore-scripts
  npm run build --workspace @cometotp/protocol
  npm run build --workspace @cometotp/extension
The Firefox package is then extension/dist/cometotp-firefox-X.Y.Z.zip, the same bytes as the one uploaded (compare with sha256sum). tsc compiles the TypeScript, with nothing bundled or minified. The only third-party code, hash-wasm 4.12.0 (Argon2id, as WebAssembly) and qrcode-generator 2.0.4, is copied unchanged from npm into lib/.

Trying it: set a password in the popup. The settings page opens from the popup's Settings. Pairing needs CometOTP for Android with a lock set: the pairing page shows a QR code that the app scans. "Fill codes into sites" in the settings asks for access to sites; the content script only looks for one-time-code fields.

The extension talks to the relay at https://relay.gigabytedevelopers.com (or one the person chooses), which passes the encrypted copy between the phone and the browser. Its API is in docs/protocol.md. Only if the person turns on "Usage statistics" in the settings (off by default) does it also tell Google Analytics, through its Measurement Protocol at https://region1.google-analytics.com, which feature was used (src/usage/), with the version, the browser's family and a random id. It checks the technicalAndInteraction consent before each message.
```

## Microsoft Edge Add-ons

The same as the Chrome Web Store, with the Chromium zip.
