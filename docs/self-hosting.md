# Running your own relay

The relay passes pairing messages between CometOTP and the browser extension and keeps each
browser's encrypted vault ([relay/README.md](../relay/README.md)). It can never read a vault, but it
does see when your phone and browser connect and from which addresses. Running your own takes that
away from anyone else, and works exactly like the official relay.

This guide runs the relay's Docker image behind [Caddy](https://caddyserver.com), which gets and
renews the HTTPS certificate on its own. CI follows the same steps on every change, with
`localhost` as the domain (`.github/workflows/relay-image.yml`).

## What you need

- A Linux server that is always on, with a public address. Any small VPS will do: the relay uses
  well under 100 MB of memory. Both `amd64` and `arm64` are supported.
- [Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/).
- A domain name for the relay, such as `relay.example.com`.
- Ports 80 and 443 open to the internet. Caddy needs port 80 to get its certificate, and redirects
  everything else there to HTTPS.

## 1. Point the domain at the server

Add an `A` record (and an `AAAA` record if the server has IPv6) for `relay.example.com` with the
server's address. Check it before going on:

```bash
dig +short relay.example.com
```

## 2. Get the files

On the server, in a folder of its own, download the Compose file, the Caddyfile and the example
settings from the release you want. Use the same version as the image; `0.1.0` here:

```bash
mkdir cometotp-relay && cd cometotp-relay
base=https://raw.githubusercontent.com/gigabytedevelopers/CometOTP-Browser/relay-v0.1.0/relay/deploy
curl -fsSLO "$base/compose.yaml"
curl -fsSLO "$base/Caddyfile"
curl -fsSL -o .env "$base/.env.example"
```

They are short: read them before you run them.

## 3. Set the domain

Edit `.env` and set `RELAY_DOMAIN` to your relay's domain:

```bash
RELAY_DOMAIN=relay.example.com
```

## 4. Start it

```bash
docker compose up -d
docker compose ps
```

After a few seconds `relay` shows as `healthy`. Caddy gets its certificate as it starts, which can
take a minute. Then check from any computer:

```bash
curl https://relay.example.com/v1/
```

It answers `{"protocol":1}`.

## 5. Use it

When you pair a browser, give the extension's pairing screen your relay's address,
`https://relay.example.com`, in place of the official one. The address travels to the phone in the
pairing code, so CometOTP needs no setting: from then on both use your relay for that browser.

A browser paired with another relay keeps using that one. To move it, remove it in CometOTP
(Settings → Security → Connected extensions) and pair it again.

## Updating

Set the new version in `.env`, then pull and restart. The data stays in its volume:

```bash
echo "RELAY_IMAGE=ghcr.io/gigabytedevelopers/cometotp-relay:0.2.0" >> .env
docker compose pull
docker compose up -d
```

Releases are listed on the
[package page](https://github.com/gigabytedevelopers/CometOTP-Browser/pkgs/container/cometotp-relay).

## Backups

You don't need one. Losing the relay's data only means pairing each browser again. If you want
one anyway, stop the relay so that the database is consistent, copy its volume, and start it again:

```bash
docker compose stop relay
docker run --rm -v cometotp-relay_relay-data:/data:ro -v "$PWD":/backup debian:trixie-slim \
  tar czf /backup/relay-data.tgz -C /data .
docker compose start relay
```

A backup holds only ciphertext and token hashes, but also vault ids, sizes and the days browsers
last checked: keep it as private as the server.

## Privacy

- The relay logs no requests, addresses or tokens: only that it started, stopped or cleaned up.
- Caddy keeps no access log unless you add a `log` directive to the Caddyfile. Leave it out.
- Anything you put in front of the server, such as a CDN or a load balancer, sees every request.
  The setup here needs none.

## Settings

The relay's settings are environment variables ([relay/README.md](../relay/README.md#running-it)).
Add them under `relay` → `environment` in `compose.yaml`, for example to allow more pairings per
address in an office behind one address:

```yaml
    environment:
      TRUST_PROXY: "1"
      LIMIT_CHANNELS_PER_HOUR: "100"
```

Keep `TRUST_PROXY` on behind Caddy: without it every request seems to come from Caddy, and all
your users share one rate limit.

## Behind another reverse proxy

If the server already runs a proxy, drop the `caddy` service from `compose.yaml` and publish the
relay on the loopback address only:

```yaml
    ports:
      - "127.0.0.1:8080:8080"
```

The proxy must:

- **set `X-Forwarded-For` to the client's address, replacing any value the client sent.** The
  relay takes the last address in it for rate limits, the one a proxy adds, so a proxy that
  appends works too, but only when it is the one proxy in front of the relay;
- **wait at least 30 seconds for an answer.** A pairing channel read waits up to 25;
- **accept bodies of at least 1 MB.** The largest vault is 1,044,520 bytes;
- **keep no access log**, and add no CORS or caching headers: the relay sets its own.

For nginx:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name relay.example.com;
    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    access_log off;
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 60s;
        proxy_buffering off;
    }
}
```

Without Docker, the relay runs on Node 22.13 or later; see [relay/README.md](../relay/README.md).

## Checking a relay

The relay's deployed tests pair a phone with a browser, store and fetch a vault, and hold a long
poll open through whatever is in front of the relay. Run them from a checkout of this repository:

```bash
npm ci && npm run build
RELAY_URL=https://relay.example.com node --test relay/dist/test/deployed.test.js
```

They create a pairing channel and a vault and delete both again. The long poll takes 25 seconds.

## When something is wrong

- **No certificate:** `docker compose logs caddy`. Usually the domain does not point at the server
  yet, or port 80 is closed.
- **`relay` is not healthy:** `docker compose logs relay`.
- **`unable to open database file`, with a folder of yours in place of the volume:** the relay
  runs as user 1000, so the folder must belong to it: `sudo chown 1000:1000 <folder>`.
