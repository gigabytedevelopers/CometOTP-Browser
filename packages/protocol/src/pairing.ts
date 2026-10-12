import { hkdf, open, randomBytes, seal, sha256 } from './crypto.js';
import {
  concat,
  fromBase64Url,
  fromBase64UrlOfLength,
  fromUtf8,
  lp,
  toBase64Url,
  u8,
  utf8,
  type Bytes,
} from './encoding.js';
import { ProtocolError } from './errors.js';

export const PAIR_LABEL = utf8('CometOTP pair v1');
const PAIR_KEYS_INFO = utf8('CometOTP pair v1 keys');

/** Seconds a QR code, and so its channel, accepts a phone's hello. */
export const HELLO_WINDOW = 120;
/** Seconds a pairing channel lasts on the relay. */
export const CHANNEL_LIFETIME = 600;

export const TO_BROWSER = 1;
export const TO_PHONE = 2;
export type Direction = typeof TO_BROWSER | typeof TO_PHONE;

/** What the browser's QR code carries (protocol §3.1). */
export interface PairingCode {
  /** The relay's base URL. */
  relay: string;
  /** 16 bytes. */
  channel: Bytes;
  /** The browser's ephemeral public key, 65 bytes. */
  browserPublicKey: Bytes;
  /** 32 bytes. */
  secret: Bytes;
  /** The browser's name as shown to the person. */
  browserName: string;
}

const URI_PREFIX = 'cometotp://pair?';
const MAX_RELAY_LENGTH = 200;
const MAX_NAME_BYTES = 64;

function checkName(name: unknown, what: string): string {
  if (typeof name !== 'string') throw new ProtocolError('bad_message', `${what} is missing`);
  const length = utf8(name).length;
  if (length < 1 || length > MAX_NAME_BYTES) {
    throw new ProtocolError('bad_message', `${what} must be 1 to ${MAX_NAME_BYTES} bytes`);
  }
  return name;
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  );
}

/**
 * Checks a relay base URL: absolute https, no credentials, query, fragment or trailing slash.
 * Plain http is only accepted for loopback and private addresses, and only when allowed (debug
 * builds and local testing).
 */
export function checkRelayUrl(relay: string, options: { allowInsecure?: boolean } = {}): string {
  let url: URL;
  try {
    url = new URL(relay);
  } catch {
    throw new ProtocolError('bad_relay', 'The relay is not a URL');
  }
  const secure = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && options.allowInsecure === true && isLocalHost(url.hostname);
  if (!secure && !localHttp) throw new ProtocolError('bad_relay', 'The relay must use https');
  if (relay.length > MAX_RELAY_LENGTH) throw new ProtocolError('bad_relay', 'The relay URL is too long');
  if (url.username || url.password || relay.includes('?') || relay.includes('#') || relay.endsWith('/')) {
    throw new ProtocolError('bad_relay', 'The relay URL must have no credentials, query, fragment or trailing slash');
  }
  return relay;
}

/** The QR code's URI, parameters in the protocol's order. */
export function formatPairingUri(code: PairingCode): string {
  return (
    `${URI_PREFIX}v=1` +
    `&r=${encodeURIComponent(code.relay)}` +
    `&c=${toBase64Url(code.channel)}` +
    `&k=${toBase64Url(code.browserPublicKey)}` +
    `&s=${toBase64Url(code.secret)}` +
    `&n=${encodeURIComponent(code.browserName)}`
  );
}

/** Reads a scanned QR code. The public key's point is checked when it is used, by `ecdh`. */
export function parsePairingUri(uri: string, options: { allowInsecureRelay?: boolean } = {}): PairingCode {
  if (!uri.startsWith(URI_PREFIX)) throw new ProtocolError('bad_uri', 'Not a CometOTP pairing code');
  const params = new Map<string, string>();
  for (const pair of uri.slice(URI_PREFIX.length).split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    try {
      params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
    } catch {
      throw new ProtocolError('bad_uri', 'Invalid percent-encoding');
    }
  }
  if (params.get('v') !== '1') {
    throw new ProtocolError('unsupported_version', 'This pairing code needs a newer version of CometOTP');
  }
  try {
    return {
      relay: checkRelayUrl(params.get('r') ?? '', { allowInsecure: options.allowInsecureRelay === true }),
      channel: fromBase64UrlOfLength(params.get('c'), 16, 'The channel'),
      browserPublicKey: fromBase64UrlOfLength(params.get('k'), 65, "The browser's key"),
      secret: fromBase64UrlOfLength(params.get('s'), 32, 'The secret'),
      browserName: checkName(params.get('n'), "The browser's name"),
    };
  } catch (error) {
    if (error instanceof ProtocolError && error.code !== 'bad_relay') throw new ProtocolError('bad_uri', error.message);
    throw error;
  }
}

/** `SHA256(PAIR_LABEL ‖ lp(r) ‖ c ‖ E_pub ‖ lp(n) ‖ P_pub)`. */
export function pairingTranscript(code: PairingCode, phonePublicKey: Bytes): Promise<Bytes> {
  return sha256(
    PAIR_LABEL,
    lp(utf8(code.relay)),
    code.channel,
    code.browserPublicKey,
    lp(utf8(code.browserName)),
    phonePublicKey,
  );
}

export interface PairingKeys {
  /** Seals messages to the browser. */
  toBrowser: Bytes;
  /** Seals messages to the phone. */
  toPhone: Bytes;
  /** Six digits in two groups, such as `135 557`. */
  sas: string;
}

/** Both pairing keys and the short authentication string, from the ECDH result (protocol §3.2). */
export async function derivePairingKeys(shared: Bytes, secret: Bytes, transcript: Bytes): Promise<PairingKeys> {
  const okm = await hkdf(concat(shared, secret), transcript, PAIR_KEYS_INFO, 68);
  const digits = String(new DataView(okm.buffer).getUint32(64) % 1_000_000).padStart(6, '0');
  return {
    toBrowser: okm.slice(0, 32),
    toPhone: okm.slice(32, 64),
    sas: `${digits.slice(0, 3)} ${digits.slice(3)}`,
  };
}

export function pairingAad(channel: Bytes, direction: Direction, index: number): Bytes {
  return concat(PAIR_LABEL, channel, u8(direction), u8(index));
}

export type PairingMessage =
  | { t: 'hello'; phone: string }
  | { t: 'confirm' }
  | { t: 'vault'; id: string; read: string; key: string }
  | { t: 'done' }
  | { t: 'cancel' };

/** The message's JSON with its members in a fixed order, so a frame is reproducible. */
function messageJson(message: PairingMessage): string {
  switch (message.t) {
    case 'hello':
      return JSON.stringify({ t: 'hello', phone: checkName(message.phone, "The phone's name") });
    case 'vault':
      return JSON.stringify({ t: 'vault', id: message.id, read: message.read, key: message.key });
    case 'confirm':
    case 'done':
    case 'cancel':
      return JSON.stringify({ t: message.t });
  }
}

function checkMessage(value: unknown): PairingMessage {
  if (typeof value !== 'object' || value === null) throw new ProtocolError('bad_message', 'Not a message');
  const message = value as Record<string, unknown>;
  switch (message.t) {
    case 'hello':
      return { t: 'hello', phone: checkName(message.phone, "The phone's name") };
    case 'vault':
      fromBase64UrlOfLength(message.id, 16, 'The vault id');
      fromBase64UrlOfLength(message.read, 32, 'The read token');
      fromBase64UrlOfLength(message.key, 32, 'The vault key');
      return { t: 'vault', id: message.id as string, read: message.read as string, key: message.key as string };
    case 'confirm':
    case 'done':
    case 'cancel':
      return { t: message.t };
    default:
      throw new ProtocolError('bad_message', 'Unknown message');
  }
}

export interface FrameOptions {
  /** 12 bytes; random when left out. Only tests pass one. */
  nonce?: Bytes;
}

/**
 * Seals a pairing message into a frame. A hello (index 1 to the browser) starts with the phone's
 * public key in the clear.
 */
export async function sealPairingFrame(
  keys: PairingKeys,
  channel: Bytes,
  direction: Direction,
  index: number,
  message: PairingMessage,
  phonePublicKey?: Bytes,
  options: FrameOptions = {},
): Promise<Bytes> {
  const isHello = direction === TO_BROWSER && index === 1;
  if (isHello !== (phonePublicKey !== undefined)) {
    throw new RangeError('Exactly the hello carries the phone public key');
  }
  const nonce = options.nonce ?? randomBytes(12);
  const key = direction === TO_BROWSER ? keys.toBrowser : keys.toPhone;
  const sealed = await seal(key, nonce, pairingAad(channel, direction, index), utf8(messageJson(message)));
  return concat(phonePublicKey ?? new Uint8Array(0), nonce, sealed);
}

/** The phone's public key at the start of a hello, which the browser needs to derive the keys. */
export function helloPhonePublicKey(frame: Bytes): Bytes {
  if (frame.length < 65 + 12 + 16) throw new ProtocolError('bad_message', 'The hello is too short');
  return frame.slice(0, 65);
}

/** Opens a frame expected at this direction and index, and checks the message in it. */
export async function openPairingFrame(
  keys: PairingKeys,
  channel: Bytes,
  direction: Direction,
  index: number,
  frame: Bytes,
): Promise<PairingMessage> {
  const start = direction === TO_BROWSER && index === 1 ? 65 : 0;
  if (frame.length < start + 12 + 16) throw new ProtocolError('bad_message', 'The frame is too short');
  const nonce = frame.slice(start, start + 12);
  const key = direction === TO_BROWSER ? keys.toBrowser : keys.toPhone;
  const plaintext = await open(key, nonce, pairingAad(channel, direction, index), frame.slice(start + 12));
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(plaintext));
  } catch {
    throw new ProtocolError('bad_message', 'The message is not JSON');
  }
  return checkMessage(value);
}

/** Decodes the vault credentials carried by a `vault` message. */
export function vaultCredentials(message: { id: string; read: string; key: string }): {
  id: Bytes;
  readToken: Bytes;
  key: Bytes;
} {
  return { id: fromBase64Url(message.id), readToken: fromBase64Url(message.read), key: fromBase64Url(message.key) };
}
