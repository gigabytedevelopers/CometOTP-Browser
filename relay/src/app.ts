import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CHANNEL_LIFETIME,
  HELLO_WINDOW,
  MAX_BLOB_LENGTH,
  ProtocolError,
  TO_BROWSER,
  TO_PHONE,
  blobVersion,
  fromBase64Url,
  fromBase64UrlOfLength,
  toBase64Url,
} from '@cometotp/protocol';

import type { RelayConfig } from './config.js';
import { RateLimiter } from './limiter.js';
import { dayString, type Channel, type HousekeepingResult, type RelayStore } from './store.js';

/** Largest pairing frame, in bytes (protocol §6.2). */
export const MAX_FRAME = 1024;
/** Most messages a channel holds in each direction. */
export const MAX_MESSAGES = 4;
const MAX_JSON = 4096;
const CHANNEL_LIFETIME_MS = CHANNEL_LIFETIME * 1000;
const HELLO_WINDOW_MS = HELLO_WINDOW * 1000;

const COMMON_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'Date, ETag, Retry-After',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** An error answered as `{"error": code}` (protocol §6.1). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

const badRequest = () => new HttpError(400, 'bad_request');
const unauthorized = () => new HttpError(401, 'unauthorized');
const notFound = () => new HttpError(404, 'not_found');

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(json);
}

function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest();
}

function sameHash(hash: Uint8Array | null, stored: Uint8Array | null): boolean {
  return hash !== null && stored !== null && hash.length === stored.length && timingSafeEqual(hash, stored);
}

/** SHA-256 of the request's bearer token, or null when there is none or it is not a 32-byte token. */
function bearerHash(req: IncomingMessage): Uint8Array | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
  if (!match) return null;
  try {
    return sha256(fromBase64UrlOfLength(match[1], 32, 'The token'));
  } catch {
    return null;
  }
}

function checkId(text: string | undefined, length: number): string {
  try {
    fromBase64UrlOfLength(text, length, 'The id');
    return text as string;
  } catch {
    throw badRequest();
  }
}

/** The request body, refusing one longer than [limit] bytes with 413 too_large. */
function readBody(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      // Answer without reading the rest, and close the connection rather than drain it.
      res.setHeader('Connection', 'close');
      reject(new HttpError(413, 'too_large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        res.setHeader('Connection', 'close');
        reject(new HttpError(413, 'too_large'));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown>> {
  const body = await readBody(req, res, MAX_JSON);
  try {
    const value: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw badRequest();
}

function hashField(body: Record<string, unknown>, name: string): Uint8Array {
  try {
    return fromBase64UrlOfLength(body[name], 32, name);
  } catch {
    throw badRequest();
  }
}

export interface Relay {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Deletes what has expired (protocol §6.4); run every few minutes. */
  housekeeping(): HousekeepingResult;
}

export function createRelay(config: RelayConfig, store: RelayStore, now: () => number = Date.now): Relay {
  const limiter = new RateLimiter();
  /** Long-polling requests waiting for a message, by channel and direction. */
  const waiters = new Map<string, Set<() => void>>();

  const waitKey = (channel: string, direction: number) => `${channel}/${direction}`;

  function notify(channel: string, direction: number): void {
    const key = waitKey(channel, direction);
    const set = waiters.get(key);
    if (!set) return;
    waiters.delete(key);
    for (const wake of set) wake();
  }

  function waitForMessage(channel: string, direction: number, req: IncomingMessage): Promise<void> {
    return new Promise((resolve) => {
      const key = waitKey(channel, direction);
      let set = waiters.get(key);
      if (!set) waiters.set(key, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set!.delete(done);
        // The last waiter to go takes the entry with it, or every unanswered channel would leave one.
        if (set!.size === 0 && waiters.get(key) === set) waiters.delete(key);
        req.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, config.longPollMs);
      set.add(done);
      req.on('close', done);
    });
  }

  function limit(key: string, max: number): void {
    const retry = limiter.hit(key, max, now());
    if (retry > 0) throw new HttpError(429, 'rate_limited', {}, { 'Retry-After': String(retry) });
  }

  function clientKey(req: IncomingMessage): string {
    // The last address is the one the proxy added. Any before it came from the client, so a proxy
    // that appends rather than replaces cannot let a client pick its own.
    const forwarded = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() : '';
    return limiter.addressId(forwarded || req.socket.remoteAddress || 'unknown');
  }

  /** The channel if it is open; 404 if unknown, 410 expired once deleted or past its lifetime. */
  function openChannel(id: string): Channel {
    const channel = store.getChannel(id);
    if (!channel) throw notFound();
    if (channel.deleted || now() - channel.createdAt >= CHANNEL_LIFETIME_MS) throw new HttpError(410, 'expired');
    return channel;
  }

  async function frameFrom(req: IncomingMessage, res: ServerResponse): Promise<Uint8Array> {
    const body = await readJson(req, res);
    let frame: Uint8Array;
    try {
      frame = fromBase64Url(String(body.m ?? ''));
    } catch {
      throw badRequest();
    }
    if (frame.length === 0) throw badRequest();
    if (frame.length > MAX_FRAME) throw new HttpError(413, 'too_large');
    return frame;
  }

  /* Pairing channels (protocol §6.2) */

  function createChannel(req: IncomingMessage, res: ServerResponse, id: string): void {
    limit(`channels:${clientKey(req)}`, config.limits.channels);
    const token = randomBytes(32);
    if (!store.createChannel(id, sha256(token), now())) throw new HttpError(409, 'exists');
    send(res, 201, { token: toBase64Url(token) });
  }

  async function postToBrowser(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const channel = openChannel(id);
    const auth = bearerHash(req);
    if (req.headers.authorization === undefined) {
      // The first post claims the channel for one phone (the hello).
      if (channel.phoneHash) throw new HttpError(409, 'claimed');
      if (now() - channel.createdAt >= HELLO_WINDOW_MS) throw new HttpError(410, 'expired');
      limit(`channels:${clientKey(req)}`, config.limits.channels);
      const frame = await frameFrom(req, res);
      const token = randomBytes(32);
      if (!store.claimChannel(id, sha256(token), TO_BROWSER, frame)) throw new HttpError(409, 'claimed');
      notify(id, TO_BROWSER);
      send(res, 201, { seq: 1, token: toBase64Url(token) });
      return;
    }
    if (!sameHash(auth, channel.phoneHash)) throw unauthorized();
    const frame = await frameFrom(req, res);
    const seq = store.addMessage(id, TO_BROWSER, frame, MAX_MESSAGES);
    if (seq === null) throw new HttpError(409, 'full');
    notify(id, TO_BROWSER);
    send(res, 201, { seq });
  }

  async function postToPhone(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const channel = openChannel(id);
    if (!sameHash(bearerHash(req), channel.browserHash)) throw unauthorized();
    if (!channel.phoneHash) throw new HttpError(409, 'not_claimed');
    const frame = await frameFrom(req, res);
    const seq = store.addMessage(id, TO_PHONE, frame, MAX_MESSAGES);
    if (seq === null) throw new HttpError(409, 'full');
    notify(id, TO_PHONE);
    send(res, 201, { seq });
  }

  async function getMessages(req: IncomingMessage, res: ServerResponse, id: string, direction: number, url: URL): Promise<void> {
    const channel = openChannel(id);
    const expected = direction === TO_BROWSER ? channel.browserHash : channel.phoneHash;
    if (!sameHash(bearerHash(req), expected)) throw unauthorized();
    const afterText = url.searchParams.get('after') ?? '0';
    if (!/^\d{1,9}$/.test(afterText)) throw badRequest();
    const after = Number(afterText);

    let messages = store.messagesAfter(id, direction, after);
    if (messages.length === 0 && config.longPollMs > 0) {
      await waitForMessage(id, direction, req);
      if (req.destroyed) return;
      openChannel(id);
      messages = store.messagesAfter(id, direction, after);
    }
    send(res, 200, { messages: messages.map((m) => ({ seq: m.seq, m: toBase64Url(m.body) })) });
  }

  function deleteChannel(req: IncomingMessage, res: ServerResponse, id: string): void {
    const channel = openChannel(id);
    const auth = bearerHash(req);
    if (!sameHash(auth, channel.browserHash) && !sameHash(auth, channel.phoneHash)) throw unauthorized();
    store.deleteChannel(id);
    notify(id, TO_BROWSER);
    notify(id, TO_PHONE);
    send(res, 204);
  }

  /* Vaults (protocol §6.3) */

  async function createVault(req: IncomingMessage, res: ServerResponse): Promise<void> {
    limit(`vaults:${clientKey(req)}`, config.limits.vaults);
    const body = await readJson(req, res);
    const id = checkId(typeof body.id === 'string' ? body.id : undefined, 16);
    const writeHash = hashField(body, 'write');
    const readHash = hashField(body, 'read');
    if (!store.createVault(id, writeHash, readHash, now())) throw new HttpError(409, 'exists');
    send(res, 201, {});
  }

  function existingVault(id: string) {
    if (store.isDeletedVault(id)) throw new HttpError(410, 'gone');
    const vault = store.getVault(id);
    if (!vault) throw notFound();
    return vault;
  }

  async function putVault(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const vault = existingVault(id);
    if (!sameHash(bearerHash(req), vault.writeHash)) throw unauthorized();
    limit(`uploads:${id}`, config.limits.uploads);
    const blob = await readBody(req, res, MAX_BLOB_LENGTH);
    let version: number;
    try {
      version = blobVersion(blob);
    } catch (error) {
      if (error instanceof ProtocolError) throw badRequest();
      throw error;
    }
    const result = store.putBlob(id, version, blob);
    if (!result.stored) throw new HttpError(409, 'stale_version', { version: result.version });
    const lastRead = store.getVault(id)?.lastReadDay ?? null;
    send(res, 200, { version, last_read: lastRead === null ? null : dayString(lastRead) });
  }

  function getVault(req: IncomingMessage, res: ServerResponse, id: string): void {
    const vault = existingVault(id);
    if (!sameHash(bearerHash(req), vault.readHash)) throw unauthorized();
    limit(`downloads:${id}`, config.limits.downloads);
    if (vault.blob === null) throw new HttpError(404, 'empty');
    store.markRead(id, now());
    const etag = `"${vault.version}"`;
    const wanted = String(req.headers['if-none-match'] ?? '')
      .split(',')
      .map((tag) => tag.trim().replace(/^W\//, ''));
    if (wanted.includes(etag)) {
      send(res, 304, undefined, { ETag: etag });
      return;
    }
    if (res.headersSent || res.destroyed) return;
    res
      .writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(vault.blob.length), ETag: etag })
      .end(Buffer.from(vault.blob));
  }

  function deleteVault(req: IncomingMessage, res: ServerResponse, id: string): void {
    const vault = existingVault(id);
    const auth = bearerHash(req);
    if (!sameHash(auth, vault.writeHash) && !sameHash(auth, vault.readHash)) throw unauthorized();
    store.deleteVault(id, now());
    send(res, 204);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const parts = url.pathname.split('/').filter((part) => part.length > 0);
    const method = req.method ?? 'GET';
    if (parts[0] !== 'v1') throw notFound();

    if (parts.length === 1 && method === 'GET') {
      return send(res, 200, { protocol: 1 }, config.version ? { 'X-Relay-Version': config.version } : {});
    }

    if (parts[1] === 'pair' && parts.length >= 3) {
      const id = checkId(parts[2], 16);
      if (parts.length === 3) {
        if (method === 'PUT') return createChannel(req, res, id);
        if (method === 'DELETE') return deleteChannel(req, res, id);
      } else if (parts.length === 4 && (parts[3] === 'to-browser' || parts[3] === 'to-phone')) {
        const direction = parts[3] === 'to-browser' ? TO_BROWSER : TO_PHONE;
        if (method === 'POST') return direction === TO_BROWSER ? postToBrowser(req, res, id) : postToPhone(req, res, id);
        if (method === 'GET') return getMessages(req, res, id, direction, url);
      }
    } else if (parts[1] === 'vaults' && parts.length === 2 && method === 'POST') {
      return createVault(req, res);
    } else if (parts[1] === 'vault' && parts.length === 3) {
      const id = checkId(parts[2], 16);
      if (method === 'PUT') return putVault(req, res, id);
      if (method === 'GET') return getVault(req, res, id);
      if (method === 'DELETE') return deleteVault(req, res, id);
    }
    throw notFound();
  }

  return {
    async handle(req, res) {
      for (const [name, value] of Object.entries(COMMON_HEADERS)) res.setHeader(name, value);
      try {
        if (req.method === 'OPTIONS') {
          send(res, 204);
          return;
        }
        await route(req, res);
      } catch (error) {
        if (error instanceof HttpError) {
          send(res, error.status, { error: error.code, ...error.extra }, error.headers);
        } else {
          // Nothing about the request is logged: it could carry ids or tokens.
          console.error('relay: internal error:', error instanceof Error ? error.message : 'unknown');
          send(res, 500, { error: 'internal' });
        }
      }
    },

    housekeeping() {
      limiter.prune(now());
      return store.housekeeping(now(), 2 * CHANNEL_LIFETIME_MS);
    },
  };
}
