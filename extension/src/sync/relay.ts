// The relay's HTTP API as the browser uses it (protocol §6). The relay allows any origin, so the
// extension needs no host permission to reach it, the official one or one of your own.
import { checkRelayUrl, fromBase64Url, toBase64Url, type Bytes } from '@cometotp/protocol';

/** The relay gigabytedevelopers runs, used unless the person picks their own. */
export const OFFICIAL_RELAY = 'https://relay.gigabytedevelopers.com';

/** Something the relay answered that the caller should act on, or no answer at all. */
export class RelayError extends Error {
  constructor(
    /** 0 when the relay could not be reached. */
    readonly status: number,
    /** The relay's error code (protocol §6.1), or "unreachable". */
    readonly code: string,
  ) {
    super(status ? `The relay answered ${status} ${code}` : 'The relay could not be reached');
    this.name = 'RelayError';
  }
}

/**
 * Checks a relay address: https, or http on this computer or the local network for testing (the
 * phone accepts http only in its debug builds). Throws the protocol's error when it is not one.
 */
export function relayUrl(text: string): string {
  return checkRelayUrl(text.trim().replace(/\/+$/, ''), { allowInsecure: true });
}

interface Options {
  token?: string;
  json?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function call(relay: string, method: string, path: string, options: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  try {
    return await fetch(relay + path, { method, headers, body, signal: options.signal, cache: 'no-store', credentials: 'omit' });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new RelayError(0, 'unreachable');
  }
}

async function failure(response: Response): Promise<RelayError> {
  let code = 'unknown';
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') code = body.error;
  } catch {
    // Not JSON: a proxy's error page, say.
  }
  return new RelayError(response.status, code);
}

/** Whether `relay` answers as a CometOTP relay speaking protocol 1. */
export async function isRelay(relay: string): Promise<boolean> {
  try {
    const response = await call(relay, 'GET', '/v1/');
    return response.ok && ((await response.json()) as { protocol?: unknown }).protocol === 1;
  } catch {
    return false;
  }
}

/** Creates pairing channel `channel` and returns the browser's token for it. */
export async function createChannel(relay: string, channel: Bytes): Promise<string> {
  const response = await call(relay, 'PUT', `/v1/pair/${toBase64Url(channel)}`);
  if (response.status !== 201) throw await failure(response);
  return ((await response.json()) as { token: string }).token;
}

export interface ChannelMessage {
  seq: number;
  frame: Bytes;
}

/**
 * The phone's messages after `after`, waiting up to the relay's limit for one; empty when none
 * came. Throws RelayError "expired" once the channel is over.
 */
export async function receive(relay: string, channel: Bytes, token: string, after: number, signal?: AbortSignal): Promise<ChannelMessage[]> {
  const response = await call(relay, 'GET', `/v1/pair/${toBase64Url(channel)}/to-browser?after=${after}`, { token, signal });
  if (response.status !== 200) throw await failure(response);
  const { messages } = (await response.json()) as { messages: { seq: number; m: string }[] };
  return messages.map((m) => ({ seq: m.seq, frame: fromBase64Url(m.m) }));
}

/** Sends a frame to the phone. */
export async function send(relay: string, channel: Bytes, token: string, frame: Bytes): Promise<void> {
  const response = await call(relay, 'POST', `/v1/pair/${toBase64Url(channel)}/to-phone`, { token, json: { m: toBase64Url(frame) } });
  if (response.status !== 201) throw await failure(response);
}

/** Deletes the channel; best effort, since it expires anyway. */
export async function deleteChannel(relay: string, channel: Bytes, token: string): Promise<void> {
  await call(relay, 'DELETE', `/v1/pair/${toBase64Url(channel)}`, { token }).catch(() => undefined);
}

export type Download =
  | { kind: 'vault'; blob: Bytes; etag: string | null }
  | { kind: 'unchanged' }
  | { kind: 'empty' }
  | { kind: 'gone' };

/** Downloads the vault with the read token; "unchanged" when it still has `etag`. */
export async function download(relay: string, vault: string, readToken: string, etag?: string): Promise<Download> {
  const response = await call(relay, 'GET', `/v1/vault/${vault}`, {
    token: readToken,
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  if (response.status === 200) {
    return { kind: 'vault', blob: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get('ETag') };
  }
  if (response.status === 304) return { kind: 'unchanged' };
  if (response.status === 410) return { kind: 'gone' };
  const error = await failure(response);
  if (error.code === 'empty') return { kind: 'empty' };
  throw error;
}
