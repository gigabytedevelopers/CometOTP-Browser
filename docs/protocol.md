# CometOTP browser sync protocol, version 1

**Status:** draft, 12 October 2026.

This is how CometOTP for Android shares its services with the CometOTP browser extension through a
relay: pairing, the encrypted vault, the code algorithms and the relay's HTTP API. It is precise
enough to build any of the three parts from it alone; `vectors/v1.json` pins down every byte.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

---

## 1. Overview

There are three parties:

- **The phone** (CometOTP for Android) owns the services. It creates and updates the vault.
- **The browser** (the extension) keeps a read-only copy and computes codes from it.
- **The relay** passes pairing messages and stores the latest vault. It is trusted with nothing:
  it never sees a key, and it cannot read or change anything without being detected.

Pairing happens once: the browser shows a QR code, the phone scans it, both screens show the same
six-digit code, and the person confirms on both. The phone then gives the browser a vault key over
the encrypted pairing channel. From then on the phone uploads a new vault version whenever its
services change, and the browser downloads it when it next checks. Neither has to be online at
the same time as the other.

```
 Browser                        Relay                         Phone
    |  PUT  /v1/pair/{c}          |                             |
    |  shows QR (c, E_pub, s) - - - - - - - - - - - - - - - - ->| scans
    |                             |<-- POST to-browser: hello --|  shows SAS
    |<-- GET to-browser: hello ---|                             |
    |  shows SAS, person confirms |                             |  person confirms
    |--- POST to-phone: confirm ->|--- GET to-phone: confirm -->|
    |                             |<-- POST /v1/vaults ---------|
    |                             |<-- PUT /v1/vault/{id} v1 ---|
    |<-- GET to-browser: vault ---|<-- POST to-browser: vault --|
    |--- POST to-phone: done ---->|--- GET to-phone: done ----->|
    |                             |                             |
    |                             |<-- PUT /v1/vault/{id} v2 ---|  services changed
    |--- GET /v1/vault/{id} ----->|                             |
```

---

## 2. Conventions

| Notation | Meaning |
| --- | --- |
| `a ‖ b` | Concatenation of byte strings. |
| `u8(n)`, `u16(n)`, `u32(n)`, `u64(n)` | Unsigned big-endian integers of 1, 2, 4 and 8 bytes. |
| `utf8(s)` | The UTF-8 bytes of a string. |
| `lp(x)` | `u16(len(x)) ‖ x`: a length-prefixed byte string. |
| `x[i:j]` | Bytes `i` up to but not including `j`. |
| `b64u(x)` | Base64url (RFC 4648 §5) **without** padding. Decoders MUST reject padding and invalid characters. |
| `base32(x)` | Base32 (RFC 4648 §6), upper case, **without** padding. |
| `SHA256(x)` | SHA-256. |
| `HKDF(ikm, salt, info, L)` | HKDF with SHA-256 (RFC 5869), output length `L` bytes. |
| `Seal(k, n, aad, p)` | AES-256-GCM with key `k`, 12-byte nonce `n`, associated data `aad`: the ciphertext followed by the 16-byte tag. `Open` is the inverse and fails on any change. |
| `ECDH(private, public)` | P-256 Diffie–Hellman: the shared point's x-coordinate as **exactly 32 bytes**, leading zeros kept (what WebCrypto's `deriveBits(…, 256)` and Java's `KeyAgreement.generateSecret()` return). |
| Public keys | P-256 points in uncompressed SEC1 form: `0x04 ‖ X ‖ Y`, 65 bytes. |
| JSON | UTF-8, RFC 8259. Receivers MUST ignore members they do not know. |

### Constants

| Name | Value |
| --- | --- |
| `PAIR_LABEL` | `utf8("CometOTP pair v1")` |
| `PAIR_KEYS_INFO` | `utf8("CometOTP pair v1 keys")` |
| `VAULT_INFO` | `utf8("CometOTP vault v1")` |
| `SERVICE_ID_LABEL` | `utf8("CometOTP service v1")` |
| `BLOB_MAGIC` | `utf8("COV1")` |
| `PAD_BLOCK` | 4096 |
| `TO_BROWSER`, `TO_PHONE` | 1, 2 |
| `HELLO_WINDOW` | 120 seconds |
| `CHANNEL_LIFETIME` | 600 seconds |

All randomness MUST come from a cryptographically secure generator (`crypto.getRandomValues`,
`SecureRandom`).

---

## 3. Pairing

### 3.1 The QR code

The browser generates, for each QR code it shows:

- an ephemeral P-256 key pair `E`;
- a 32-byte secret `s`;
- a 16-byte channel id `c`;

creates the channel on the relay (§6.2), and encodes this URI in the QR code:

```
cometotp://pair?v=1&r=<relay>&c=<b64u(c)>&k=<b64u(E_pub)>&s=<b64u(s)>&n=<browser name>
```

| Parameter | Value |
| --- | --- |
| `v` | `1`. A phone that sees any other value MUST refuse and say that CometOTP needs updating. |
| `r` | The relay's base URL, percent-encoded as by JavaScript's `encodeURIComponent`. An absolute `https` URL with no query, fragment or trailing slash; it MAY have a path. At most 200 characters. `http` is only accepted for loopback and private addresses, and only by debug builds. |
| `c`, `k`, `s` | The channel id, the browser's public key and the secret. |
| `n` | The browser's name as shown to the person, such as `Chrome on macOS`, percent-encoded like `r`. 1 to 64 bytes of UTF-8 once decoded. |

The browser writes the parameters in this order, and the phone MUST accept any order and ignore
parameters it does not know. The phone MUST check that `k` is a valid point on P-256 (§9.3) and
refuse the code otherwise.

The QR code expires after `HELLO_WINDOW`. The browser then makes a new one, with new `E`, `s` and
`c`.

### 3.2 Keys and the short authentication string

The phone generates an ephemeral P-256 key pair `P`. Both sides then compute:

```
transcript = SHA256(PAIR_LABEL ‖ lp(utf8(r)) ‖ c ‖ E_pub ‖ lp(utf8(n)) ‖ P_pub)
Z          = ECDH(P_priv, E_pub)            (the browser: ECDH(E_priv, P_pub))
okm        = HKDF(Z ‖ s, transcript, PAIR_KEYS_INFO, 68)

K_browser  = okm[0:32]     key for messages to the browser
K_phone    = okm[32:64]    key for messages to the phone
SAS        = u32(okm[64:68]) mod 1,000,000
```

The SAS is shown as six digits with leading zeros, in two groups of three: `135 557`.

`r` and `n` are the decoded strings, exactly as they appeared in the QR code.

### 3.3 Messages

Pairing messages travel through the relay's channel (§6.2) as opaque frames:

```
aad   = PAIR_LABEL ‖ c ‖ u8(direction) ‖ u8(index)
frame = nonce ‖ Seal(key, nonce, aad, utf8(json))           (the hello: P_pub ‖ nonce ‖ …)
```

- `direction` is `TO_BROWSER` (key `K_browser`) or `TO_PHONE` (key `K_phone`).
- `index` counts the messages in that direction, starting at 1. Each side knows which index it
  expects next, and MUST abort the pairing if a frame fails to open.
- `nonce` is 12 fresh random bytes.
- The first frame to the browser, the hello, starts with `P_pub` in the clear, since the browser
  needs it to compute the keys.

| Direction | Index | JSON | Sent when |
| --- | --- | --- | --- |
| to the browser | 1 | `{"t":"hello","phone":"<phone name>"}` | The phone has scanned the QR code. The phone name is 1 to 64 bytes of UTF-8. |
| to the phone | 1 | `{"t":"confirm"}` | The person confirmed in the browser that the phone shows the same SAS. |
| to the browser | 2 | `{"t":"vault","id":"<b64u>","read":"<b64u>","key":"<b64u>"}` | The person confirmed on the phone, the confirm has arrived, and vault version 1 is on the relay (§3.4). `id` is the vault id, `read` the read token and `key` the vault key `V` (§4.1). |
| to the phone | 2 | `{"t":"done"}` | The browser has stored the vault credentials. |

Either side MAY send `{"t":"cancel"}` instead of its next message; the other side then aborts. An
unexpected `t` also aborts the pairing.

### 3.4 What each side does

**Browser:**

1. Generates `E`, `s` and `c`, creates the channel (`PUT /v1/pair/{c}`) and shows the QR code.
2. Waits for the hello (long-polling `GET …/to-browser`). If none arrives within `HELLO_WINDOW`,
   it deletes the channel and starts again from step 1.
3. Checks `P_pub` (§9.3), computes the keys and opens the hello. On any failure it deletes the
   channel and tells the person pairing failed.
4. Shows the SAS and the phone's name, with **My phone shows the same code** and **Cancel**.
5. On confirmation, sends `confirm` and waits for the vault message. On `cancel`, stops.
6. Stores the relay URL, vault id, read token, vault key and phone name (§8), sends `done`,
   forgets `E`, `s` and the pairing keys, and downloads the vault (§7.2).

**Phone:**

1. Requires that CometOTP has a lock, then scans the QR code and checks it (§3.1).
2. Generates `P`, computes the keys and sends the hello. This first post claims the channel
   (§6.2). If the relay answers that the channel is already claimed, the phone tells the person
   that the code was already used; if it has expired, that the code expired.
3. Shows the SAS and the browser's name, with **Pair** and **Cancel**.
4. Waits until the person has tapped **Pair** and the browser's `confirm` has arrived, in either
   order.
5. Generates the vault credentials (§4.1), creates the vault (`POST /v1/vaults`), uploads version
   1 (§7.1), records the pairing as pending, and sends the vault message.
6. When `done` arrives, records the pairing as complete and deletes the channel. If the channel
   expires first, it deletes the vault and the pending pairing and tells the person pairing failed.
   A pending pairing still present when CometOTP next starts is cleaned up the same way.

---

## 4. The vault

### 4.1 Credentials

The phone creates, for each paired browser:

| Value | Size | Use |
| --- | --- | --- |
| vault id | 16 random bytes | Names the vault on the relay; `b64u` in URLs. |
| write token `W` | 32 random bytes | Lets the phone upload and delete. Never leaves the phone and the relay. |
| read token `R` | 32 random bytes | Lets the browser download and delete. |
| vault key `V` | 32 random bytes | Encrypts the vault. Never reaches the relay. |

Tokens are sent as `Authorization: Bearer <b64u(token)>`. The relay stores only `SHA256(W)` and
`SHA256(R)`.

### 4.2 Blob

```
K_vault = HKDF(V, vault id, VAULT_INFO, 32)
header  = BLOB_MAGIC ‖ u64(version)
padded  = u32(len(json)) ‖ json ‖ zero bytes, to the next multiple of PAD_BLOCK
blob    = header ‖ nonce ‖ Seal(K_vault, nonce, header ‖ vault id, padded)
```

- `json` is the UTF-8 payload (§4.3).
- `version` starts at 1 and goes up by one with each upload. It MUST stay below 2^53, so that
  JavaScript can hold it exactly.
- `nonce` is 12 fresh random bytes.
- The padded length is 1 to 255 blocks, so a blob is `40 + 4096 × k` bytes, from 4,136 to
  1,044,520 bytes. Padding hides how many services there are, to within a block.

The header is in the clear so that the relay can enforce the version rule (§6.3); it is also part
of the associated data, so changing it makes the blob fail to open.

### 4.3 Payload

```json
{
  "v": 1,
  "phone": "Galaxy S25 Ultra",
  "updated": 1791763200,
  "services": [
    {
      "id": "…",
      "type": "totp",
      "secret": "JBSWY3DPEHPK3PXP",
      "algorithm": "SHA1",
      "digits": 6,
      "period": 30,
      "issuer": "GitHub",
      "label": "alice@example.com",
      "icon": "Github",
      "tags": ["Work"]
    }
  ]
}
```

| Member | Required | Value |
| --- | --- | --- |
| `v` | yes | `1`. A browser seeing a higher number keeps its current copy and says the extension needs updating. |
| `phone` | yes | The phone's name, 1 to 64 bytes of UTF-8. |
| `updated` | yes | When the phone built this version, in Unix seconds. The browser shows it ("Updated 2 hours ago"), which makes a relay that withholds updates visible. |
| `services` | yes | The shared services, in the phone's list order. May be empty. |

Each service:

| Member | Required | Value |
| --- | --- | --- |
| `id` | yes | The service id (§4.4). Unique within the payload. |
| `type` | yes | `"totp"` or `"steam"`. |
| `secret` | yes | `base32` of the secret; not empty. |
| `algorithm` | yes | `"SHA1"`, `"SHA256"` or `"SHA512"`. |
| `digits` | yes | 4 to 10: the number of digits, or of characters for Steam. |
| `period` | yes | Seconds per code, 1 or more. |
| `issuer` | yes | May be empty. |
| `label` | yes | May be empty. |
| `icon` | no | The name of a CometOTP icon. Browsers that do not have that icon use the initials. |
| `initials` | no | 1 or 2 characters chosen by the person. |
| `badge` | no | The initials' background colour as `#RRGGBB`, when the person chose one. |
| `tags` | no | Tag names. |

The phone MUST NOT include HOTP or mOTP services: a read-only copy cannot keep an HOTP counter in
step, and mOTP needs a PIN typed at use. It includes every other service whose **Browser
extension** switch is on.

A browser MUST skip a service with an unknown `type`, or one that breaks these rules, and show the
rest; one bad service does not discard the vault.

### 4.4 Service ids

```
id = b64u(SHA256(SERVICE_ID_LABEL ‖ secret bytes)[0:12])        16 characters
```

The id depends only on the secret, which CometOTP never lets the person edit, so it stays the same
when the service is renamed. The browser uses it to remember which sites belong to which service.
If two services share a secret, the phone includes only the first.

---

## 5. Codes

For a service and a time `t` in Unix seconds:

```
counter = floor(t / period)
h       = HMAC-<algorithm>(secret, u64(counter))
offset  = h[len(h) - 1] & 0x0F
value   = u32(h[offset : offset + 4]) & 0x7FFFFFFF
```

- **`totp`** (RFC 6238): `value mod 10^digits`, written in decimal with leading zeros to `digits`
  characters.
- **`steam`**: `digits` characters, each `"23456789BCDFGHJKMNPQRTVWXY"[value mod 26]`, after which
  `value = floor(value / 26)`.

These match CometOTP's `TokenCalculator`. Codes depend on the clock, so the browser warns when
its clock and the relay's `Date` header differ by more than 30 seconds.

---

## 6. Relay HTTP API

### 6.1 General

- Paths are relative to the relay's base URL `r`. Everything is served over HTTPS, except for
  local testing.
- `GET /v1/` answers `200 {"protocol": 1}`, so a self-hosted relay's URL can be checked.
- Every response carries `Cache-Control: no-store`.
- **CORS:** every response, and every `OPTIONS` preflight, carries
  `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Methods: GET, POST, PUT, DELETE`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, If-None-Match`,
  `Access-Control-Expose-Headers: Date, ETag, Retry-After` and
  `Access-Control-Max-Age: 86400`. No cookies are used, so `*` is safe, and the extension needs no
  host permission for a self-hosted relay.
- **Errors** are JSON: `{"error": "<code>"}`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | Malformed request or body. |
| 401 | `unauthorized` | Missing or wrong token. |
| 404 | `not_found` | No such channel or vault. |
| 404 | `empty` | The vault exists but has no blob yet. |
| 409 | `exists` | The channel or vault id is taken. |
| 409 | `claimed` | Another phone already answered this channel. |
| 409 | `not_claimed` | The browser posted before any phone answered. |
| 409 | `full` | That direction of the channel already holds its 4 messages. |
| 409 | `stale_version` | The upload's version is not above the stored one; the body also has `"version": <stored>`. |
| 410 | `expired` | The channel's time is up. |
| 410 | `gone` | The vault was deleted (§6.3). |
| 413 | `too_large` | The body is over its limit. |
| 429 | `rate_limited` | Too many requests; `Retry-After` says when to try again. |

- **Tokens** are compared by hash, in constant time.
- **Privacy:** the relay MUST NOT log IP addresses together with channel or vault ids, and MUST
  NOT log tokens or bodies at all.
- **Rate limits:** the relay SHOULD limit, per IP address, channel creation and claims to 30 and
  vault creation to 20 an hour, and per vault, downloads to 120 and uploads to 240 an hour.

### 6.2 Pairing channels

| Request | Token | Response |
| --- | --- | --- |
| `PUT /v1/pair/{c}` | none | `201 {"token": "<b64u>"}`: the browser's 32-byte channel token. `409 exists` if `c` is in use. |
| `POST /v1/pair/{c}/to-browser` with `{"m": "<b64u(frame)>"}` | none for the first, then the phone's | The first post **claims** the channel: `201 {"seq": 1, "token": "<b64u>"}`, the phone's 32-byte channel token. It MUST arrive within `HELLO_WINDOW` of the channel's creation (`410 expired`) and only once (`409 claimed`). Later posts need the phone's token: `201 {"seq": n}`. |
| `POST /v1/pair/{c}/to-phone` with `{"m": …}` | browser's | `201 {"seq": n}`; `409 not_claimed` before the claim. |
| `GET /v1/pair/{c}/to-browser?after=n` | browser's | `200 {"messages": [{"seq": k, "m": "<b64u>"}, …]}` with every message after `seq` `n`, in order. When there is none yet, the relay waits up to 25 seconds before answering with an empty list. |
| `GET /v1/pair/{c}/to-phone?after=n` | phone's | The same, for the other direction. |
| `DELETE /v1/pair/{c}` | either | `204`. |

A frame is at most 1,024 bytes (`413 too_large` beyond) and a direction holds at most 4
messages (`409 full` beyond). A channel lasts `CHANNEL_LIFETIME` from its creation. Requests for
it after that, or after it was deleted, get `410 expired`, and its id cannot be created again
until a further `CHANNEL_LIFETIME` has passed.

### 6.3 Vaults

| Request | Token | Response |
| --- | --- | --- |
| `POST /v1/vaults` with `{"id": "<b64u>", "write": "<b64u(SHA256(W))>", "read": "<b64u(SHA256(R))>"}` | none | `201 {}`. `409 exists` if the id is taken or was deleted. |
| `PUT /v1/vault/{id}` with the blob, `Content-Type: application/octet-stream` | `W` | Stores the blob if its version is above the stored one: `200 {"version": v, "last_read": "YYYY-MM-DD" or null}`, the day the browser last downloaded it. Otherwise `409 stale_version`. A blob without `BLOB_MAGIC`, or with a length other than `40 + 4096 × k`, is `400`; one over 1,044,520 bytes is `413`. |
| `GET /v1/vault/{id}` | `R` | `200` with the blob, `Content-Type: application/octet-stream` and `ETag: "<version>"`. With `If-None-Match` equal to the current ETag: `304`. Records the day (UTC) as `last_read`. `404 empty` before the first upload. |
| `DELETE /v1/vault/{id}` | `W` or `R` | `204`. Afterwards every request for this vault, including another delete, gets `410 gone`. |

The relay stores per vault: the id, `SHA256(W)`, `SHA256(R)`, the version, the blob, and
`last_read` as a date. It keeps the ids of deleted vaults (as `SHA256(id)`) for 180 days so that it
can answer `410` rather than `404`.

### 6.4 Housekeeping

- A vault never downloaded within 7 days of its creation is deleted: its pairing never finished.
- A vault not downloaded for 180 days is deleted.
- Channels, and their messages, are forgotten a further `CHANNEL_LIFETIME` after they expire.

---

## 7. Keeping the copy current

### 7.1 Phone

- The phone uploads after pairing, and after any change that alters the payload apart from
  `updated`: a service added, edited, deleted or switched on or off. It keeps, per browser, the
  last version it uploaded and a hash of that payload without `updated`, and skips uploads that
  would change nothing.
- Each upload uses the next version. On `409 stale_version` it continues from the version the
  relay returned, plus one, and retries once.
- Uploads only happen while CometOTP is unlocked, because building the payload needs the database
  key. A failed upload MAY be retried in the background with the already-sealed blob.
- While CometOTP has no lock, the phone uploads nothing and shows syncing as paused.
- `410 gone` means the browser disconnected: the phone removes the pairing and says so.
  `401` or `404` means the relay lost the vault: the phone marks the pairing as needing to be
  paired again.

### 7.2 Browser

- The browser downloads at start-up, on unlock, when its popup opens, and every 15 minutes, with
  `If-None-Match` set to the version it has.
- On `200` it MUST check, before replacing its copy, that:
  1. the header starts with `BLOB_MAGIC`;
  2. the version is **not lower** than the highest version it has accepted from this vault
     (otherwise the relay is serving an old vault: it keeps its copy and warns);
  3. the blob opens with `K_vault` (otherwise it keeps its copy and warns);
  4. the payload's `v` is 1.
  It then replaces its copy and remembers the version.
- `410 gone` means the phone removed this browser: the extension deletes everything it holds for
  this pairing and says it was disconnected. `401` or `404` keep the copy and say the browser
  needs pairing again.
- **Disconnect** sends `DELETE /v1/vault/{id}` with `R`, then deletes the pairing's data even if
  that request fails.

---

## 8. Storage in the browser (informative)

This part does not affect the other parties; it records the design for review.

- A random 32-byte local key `M` encrypts the vault key, the downloaded payload and the site
  links, with AES-256-GCM.
- `M` is stored wrapped twice:
  - by `Argon2id(password, 16-byte salt, m = 64 MiB, t = 3, p = 1, 32 bytes)`, with the password
    NFC-normalized and UTF-8 encoded, and `utf8("CometOTP lock v1 password")` as the associated
    data;
  - by `HKDF(prf, "", utf8("CometOTP unlock v1 passkey"), 32)`, where `prf` is the WebAuthn PRF
    output for input `SHA256(utf8("CometOTP unlock v1 prf"))`, when a passkey is set up, with
    `utf8("CometOTP lock v1 passkey")` as the associated data. The passkey belongs to the
    extension's own origin, and user verification is required.
- The relay URL, vault id, read token and highest accepted version stay outside `M`, so the
  extension can download while locked; the blob itself stays sealed under `V`. `V` and the
  phone's name are sealed under `M`.
- Each value sealed under `M` has `utf8("CometOTP local v1") ‖ lp(utf8(name))` as its associated
  data, so stored values cannot be swapped for one another.
- While unlocked, `M` is kept in `storage.session`, which is memory only and closed to content
  scripts. Locking clears it.

---

## 9. Security considerations

The threat model is in the design document (`docs/design.md`); these are the protocol's own points.

### 9.1 Pairing

- The QR code is the one authenticated channel. The phone trusts `E_pub` because its camera read
  it. The browser trusts the phone because only something that read `s` can produce `K_browser`.
- Someone who also saw the QR code, for example during screen sharing, could race the real phone.
  Three things stop that: the code is single-use and short-lived, the relay lets only one phone
  claim a channel, and the person confirms the SAS **on both sides**. An impostor's SAS would not
  match the real phone, which in any case would be told the code was already used.
- An attacker able to change a pairing message, including `P_pub` in the hello, changes the keys,
  and the frame fails to open.
- The SAS has about 20 bits. The bias of taking 32 bits modulo 10^6 is below 0.03% and does not
  matter.

### 9.2 Vault

- The relay sees vault ids, padded sizes, when uploads and downloads happen, and IP addresses. It
  cannot read the vault, change it, or replay an older one to a browser that has seen a newer
  version. It can withhold updates; `updated` makes that visible.
- Nonces are random. A vault key seals one blob per upload, far below the 2^32 messages AES-GCM
  allows with random nonces.
- Deleting a vault stops updates. It does not take back secrets a browser already holds.

### 9.3 Public keys

Both sides MUST check that a received public key is 65 bytes, starts with `0x04`, has coordinates
below the field prime and satisfies `y² = x³ − 3x + b (mod p)`. WebCrypto's `importKey` does this.
On Android, check it explicitly before `KeyFactory.generatePublic`, since not every provider does.
`AlgorithmParameters "EC"` only exists from API 26; at minSdk 24, take the curve's parameters from a
key generated with `ECGenParameterSpec("secp256r1")` (see `vectors/check-jvm`).

---

## 10. Versioning

The version appears in the URI (`v=1`), the API paths (`/v1/`), every label (`… v1`), the blob
magic (`COV1`) and the payload (`"v": 1`). Adding JSON members does not need a new version;
receivers ignore what they do not know. Anything else does, and a relay MAY serve several versions
side by side.

---

## 11. Test vectors

`vectors/v1.json` holds, from fixed inputs:

- **pairing:** both key pairs, `s`, `c`, the URI, `Z` (which happens to start with a zero byte),
  the transcript hash, the keys, the SAS (`135 557`) and the four messages with their nonces,
  associated data and frames;
- **vault:** the credentials and token hashes, `K_vault`, the payload, its padded length and the
  blob;
- **service ids**;
- **codes:** the RFC 6238 table, other lengths and periods, and Steam;
- **reject:** inputs every implementation MUST refuse: a tampered frame, frames opened with the
  wrong index or direction, a blob whose header was changed, and a public key off the curve.

`vectors/generate.mjs` builds the file with Node's crypto; `vectors/check-jvm/CheckVectors.java`
recomputes all of it with the Java APIs Android uses. An implementation is only finished when it
reproduces every value and refuses every `reject` entry.
