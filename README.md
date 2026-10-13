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

## Documentation

- **[Design](docs/design.md):** what is shared, pairing, syncing, the extension's lock, unpairing,
  the threat model and the plan of pull requests.
- **[Protocol, version 1](docs/protocol.md):** pairing, the encrypted vault, the codes and the
  relay's API, precise enough to build any of the three parts from.

## Repository layout

| Path | What it is |
| --- | --- |
| `docs/` | The design and the sync protocol. |
| `vectors/` | Protocol test vectors, shared with CometOTP for Android. |
| `packages/protocol/` | The protocol in TypeScript, shared by the relay and the extension. |
| `relay/` | The relay server ([how to run it](relay/README.md)); its Docker image is to come. |
| `extension/` | *To come:* the extension, built for Chromium and for Firefox. |

## Checking the protocol test vectors

Every implementation of the protocol has to reproduce `vectors/v1.json`. Regenerating it (Node 20
or later) must not change it:

```bash
node vectors/generate.mjs && git diff --exit-code vectors/v1.json
```

An independent implementation with the Java crypto APIs CometOTP for Android uses (JDK 17 or later)
recomputes every value:

```bash
java vectors/check-jvm/CheckVectors.java vectors/v1.json
```

## Contributing

Every change goes through a pull request reviewed by @princesseke, and every commit is signed. How
changes are reviewed, checked and merged is in [.github/RELEASING.md](.github/RELEASING.md).

## License

[MIT](LICENSE)
