# The relay's image (docs/self-hosting.md). Build it from the repository root, since the relay
# needs the protocol package beside it:
#
#   docker build -f relay/Dockerfile -t cometotp-relay .
#
# Both stages use the same Node image, pinned by digest so that a rebuild gets exactly the one that
# was reviewed. Update the two lines together.

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS build
WORKDIR /src

# The lockfile alone decides what is installed, and no install scripts run (.npmrc).
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY relay/package.json relay/
RUN npm ci --ignore-scripts --no-audit

COPY packages/protocol packages/protocol
COPY relay relay
# The relay's tests run here too, on the image's Node, which may be newer than CI's.
RUN npm run build --workspace @cometotp/protocol --workspace @cometotp/relay \
 && npm test --workspace @cometotp/relay


FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

LABEL org.opencontainers.image.title="CometOTP relay" \
      org.opencontainers.image.description="Passes pairing messages and keeps encrypted vaults for the CometOTP browser extension. It stores only ciphertext and token hashes." \
      org.opencontainers.image.source="https://github.com/gigabytedevelopers/CometOTP-Browser" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/relay.sqlite

# Only the compiled code: no dev dependencies, tests or sources. The protocol package goes where
# Node looks for @cometotp/protocol. Everything here belongs to root and is read-only to the relay.
WORKDIR /app
COPY --from=build /src/relay/package.json relay/package.json
COPY --from=build /src/relay/dist/src relay/dist/src
COPY --from=build /src/packages/protocol/package.json node_modules/@cometotp/protocol/package.json
COPY --from=build /src/packages/protocol/dist/src node_modules/@cometotp/protocol/dist/src

# The database is the only thing written, on its own volume, by the image's unprivileged user.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/v1/`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Node runs as PID 1 and stops cleanly on SIGTERM (relay/src/main.ts).
CMD ["node", "relay/dist/src/main.js"]
