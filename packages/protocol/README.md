# @cometotp/protocol

[Protocol version 1](../../docs/protocol.md) in TypeScript, shared by the relay and the extension.
It uses only WebCrypto, so the same code runs in browsers and in Node 20 or later, and has no
runtime dependencies.

| Module | What it covers |
| --- | --- |
| `encoding` | Strict base64url and base32, UTF-8, and the protocol's integer and length-prefix encodings. |
| `crypto` | SHA-256, HKDF, AES-256-GCM, and P-256 key pairs and ECDH, with every received public key checked on the curve. |
| `pairing` | The QR code URI, relay URL checks, the transcript, keys and SAS, and sealing and opening pairing messages. |
| `vault` | Sealing and opening vault blobs, with padding, version and rollback checks; payloads and service ids. |
| `codes` | TOTP and Steam codes, matching CometOTP's `TokenCalculator`. |

Anything received from another party that breaks the protocol throws a `ProtocolError` whose
`code` says why: `auth_failed` for anything that fails to open, `rollback` for an older vault,
`unsupported_version` when a newer app or extension is needed, and so on.

```bash
npm ci
npm test --workspace @cometotp/protocol
```

The tests reproduce every value in [`vectors/v1.json`](../../vectors/v1.json) and refuse every
`reject` entry, plus the rules the vectors do not pin down.
