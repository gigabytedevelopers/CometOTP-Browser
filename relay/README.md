# CometOTP relay

The relay passes pairing messages between CometOTP for Android and the browser extension, and keeps
the latest encrypted vault for each paired browser ([protocol §6](../docs/protocol.md#6-relay-http-api)).
It is trusted with nothing: it stores only ciphertext and SHA-256 hashes of tokens, and cannot read,
change or roll back a vault without the browser noticing.

It is plain Node (22.13 or later) with no dependencies besides the shared protocol package: the
HTTP server and SQLite (`node:sqlite`) are Node's own.

## Running it

To run your own, follow [Running your own relay](../docs/self-hosting.md): the Docker image
`ghcr.io/gigabytedevelopers/cometotp-relay` behind Caddy, which takes care of HTTPS.

The image is built from the repository root, since the relay needs the protocol package beside it.
It runs as an unprivileged user and keeps its database in the volume `/data`:

```bash
docker build -f relay/Dockerfile -t cometotp-relay .
docker run -d -p 127.0.0.1:8080:8080 -v relay-data:/data cometotp-relay
```

Without Docker:

```bash
npm ci
npm run build
DATABASE_PATH=relay.sqlite npm start --workspace @cometotp/relay
```

Either way, put it behind a reverse proxy that terminates HTTPS, and set `TRUST_PROXY=1` there.

| Variable | Default | What it sets |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to listen on. |
| `DATABASE_PATH` | `relay.sqlite` (`/data/relay.sqlite` in the image) | The SQLite file. Back it up if you like; losing it means every browser has to pair again. |
| `TRUST_PROXY` | off | `1` to take the client's address from `X-Forwarded-For`, for rate limits only. Set it only behind a proxy that sets that header. |
| `LONG_POLL_MS` | `25000` | How long a pairing channel read waits for a message. |
| `LIMIT_CHANNELS_PER_HOUR` | `30` | Channels created and claimed, per client address. |
| `LIMIT_VAULTS_PER_HOUR` | `20` | Vaults created, per client address. |
| `LIMIT_DOWNLOADS_PER_HOUR` | `120` | Downloads, per vault. |
| `LIMIT_UPLOADS_PER_HOUR` | `240` | Uploads, per vault. |
| `MAX_VAULTS` | `100000` | Vaults kept, in all. |
| `MAX_VAULT_MB` | `2048` | Vault blobs kept, in all, in MiB (1,048,576 bytes). |
| `MAX_CHANNELS` | `10000` | Pairing channels kept, in all; each is kept for 20 minutes. |

A client address is an IPv4 address, or the /64 an IPv6 address is in: a subscriber is usually
given a whole /64, and could otherwise take a new address for every request. The relay keeps up to
100,000 counts at a time (about 15 MB); beyond that it forgets the oldest first.

The `MAX_` settings cap what the relay keeps however many clients ask, so that together they cannot
fill its disk. At a cap it answers `503 at_capacity` to a new channel or vault, or to an upload
larger than the blob it replaces, until channels expire or vaults are deleted; downloads, and
uploads no larger than before, carry on. With the defaults the database stays under about 2.5 GB.

## What it keeps, and what it does not

- **Vaults:** the id, the hashes of the write and read tokens, the version, the blob, when it was
  created, and the day (not the time) it was last downloaded.
- **Deleted vaults:** the SHA-256 of their ids for 180 days, so the phone and browser hear `410`.
- **Pairing channels:** the hashes of the browser's and phone's channel tokens and up to four
  sealed messages each way, for 20 minutes at most.
- **Never:** IP addresses (rate limits count them in memory under a key made fresh at each start),
  tokens, request bodies or logs of requests. It logs only that it started, stopped, or cleaned up.

Every few minutes it deletes vaults never downloaded within 7 days of being made or not downloaded
for 180 days, forgets deleted vault ids after 180 days, and drops channels 20 minutes after they
were made.

## Tests

```bash
npm test --workspace @cometotp/relay
```

They run every endpoint and error code over HTTP against an in-memory database, with a clock they
move to check expiry and clean-up.

`test/deployed.test.ts` checks a relay that is already running, through whatever stands in front of
it: a pairing between a phone and a browser, a vault, and a long poll held open for its full 25
seconds. It runs only when `RELAY_URL` is set:

```bash
RELAY_URL=https://relay.example.com node --test relay/dist/test/deployed.test.js
```

With `RELAY_VERSION` set too, they also check that the relay says it runs that version
(`X-Relay-Version`).

CI builds the image on every pull request, starts it with `deploy/compose.yaml` as the
self-hosting guide does, and runs these tests through Caddy. Each release is deployed to the
official relay with `deploy/coolify.yaml` and tested there the same way
([.github/RELEASING.md](../.github/RELEASING.md)).
