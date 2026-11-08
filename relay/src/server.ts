import { createServer, type Server } from 'node:http';

import { MAX_BLOB_LENGTH } from '@cometotp/protocol';

import type { Relay } from './app.js';

/** The slowest upload the relay waits for, in bytes a second: about 65 kbit/s. */
export const MIN_UPLOAD_RATE = 8 * 1024;

/**
 * How long a request may take to arrive, headers and body: long enough for the largest blob at
 * MIN_UPLOAD_RATE, a little over two minutes. Node stops counting once the request has arrived, so
 * a long poll, which waits after that before answering, needs no allowance here.
 */
export const REQUEST_TIMEOUT_MS = Math.ceil(MAX_BLOB_LENGTH / MIN_UPLOAD_RATE) * 1000;

/** The relay's HTTP server, not yet listening. */
export function createRelayServer(relay: Relay): Server {
  const server = createServer((req, res) => void relay.handle(req, res));
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 15_000;
  return server;
}
