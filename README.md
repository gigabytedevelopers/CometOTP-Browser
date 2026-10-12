# CometOTP for browsers

Your [CometOTP](https://github.com/gigabytedevelopers/CometOTP) two-factor codes on your
computer, even when your phone is not with you.

> **In development.** There is nothing to install yet. Progress is tracked on the
> [project board](https://github.com/orgs/gigabytedevelopers/projects/3).

## What it will do

- **Pair once.** The extension shows a QR code, CometOTP on Android scans it, and both screens show
  the same six-digit code so you can check that nobody else answered.
- **Stay current.** From then on your phone keeps an end-to-end-encrypted copy of your services up
  to date in the extension, through a relay that cannot read it.
- **Work without the phone.** The extension shows your codes in its popup and fills them into
  sign-in pages, with the phone switched off or at home.
- **Run where you browse:** Chrome, Edge, Brave, Opera and Vivaldi (Manifest V3), and Firefox.

## How your secrets are protected

- **The phone stays in charge.** Only CometOTP on the phone can add, change or remove services; the
  browser's copy is read-only.
- **The relay sees nothing useful.** The copy is encrypted with a random key that only your phone
  and your browser hold. The relay stores ciphertext, keeps no IP logs and can be self-hosted.
- **The extension has its own lock:** a password, or a passkey (Touch ID, Windows Hello, a phone or
  a security key). It locks itself when idle, when the computer locks and when the browser quits.
- **You choose what is shared.** Pairing needs a lock on CometOTP, and any service can be kept on
  the phone with its **Browser extension** switch. HOTP and mOTP services always stay on the phone.

**What it cannot do:** once a browser has a copy, removing that browser stops its updates but
cannot take back what it already holds. If a computer with the extension is lost or stolen, remove
it in CometOTP and reset two-factor authentication on the services it had.

## Repository layout (planned)

| Path | What it is |
| --- | --- |
| `docs/` | The design and the sync protocol. |
| `vectors/` | Protocol test vectors, shared with CometOTP for Android. |
| `packages/protocol/` | The protocol in TypeScript, shared by the relay and the extension. |
| `relay/` | The relay server and its Docker image. |
| `extension/` | The extension, built for Chromium and for Firefox. |

## Contributing

Every change goes through a pull request reviewed by @princesseke, and every commit is signed. How
changes are reviewed, checked and merged is in [.github/RELEASING.md](.github/RELEASING.md).

## License

[MIT](LICENSE)
