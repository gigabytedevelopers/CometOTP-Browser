import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { createRelay } from './app.js';
import { configFromEnv } from './config.js';
import { RelayStore } from './store.js';

const HOUSEKEEPING_MS = 5 * 60 * 1000;

// relay/package.json, two levels up from dist/src both here and in the image.
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

const config = { ...configFromEnv(), version };
const store = new RelayStore(config.databasePath);
const relay = createRelay(config, store);

const server = createServer((req, res) => void relay.handle(req, res));
// Long polls hold a request open for longPollMs; allow a little more.
server.requestTimeout = config.longPollMs + 10_000;
server.headersTimeout = 15_000;

const housekeeping = setInterval(() => {
  const result = relay.housekeeping();
  if (result.vaultsDeleted + result.channelsDropped > 0) {
    console.log(`relay: housekeeping deleted ${result.vaultsDeleted} vaults and ${result.channelsDropped} channels`);
  }
}, HOUSEKEEPING_MS);
housekeeping.unref();

server.listen(config.port, config.host, () => {
  console.log(`relay ${version}: listening on ${config.host}:${config.port}`);
});

function stop(): void {
  console.log('relay: stopping');
  clearInterval(housekeeping);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
