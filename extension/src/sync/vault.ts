// Whether a downloaded vault may replace the copy the browser has (protocol §7.2): its header is a
// vault's, its version is not lower than the highest accepted, it opens with the vault key, and
// its payload is version 1. Apart from storage, so it can be tested on its own.
import { ProtocolError, blobVersion, openVault, parsePayload, type Bytes, type Payload } from '@cometotp/protocol';

export type Assessment =
  /** Take it: a newer version that opens and reads. */
  | { kind: 'accept'; version: number; payload: Payload; skipped: number }
  /** Older than the copy: the relay is serving an old vault. */
  | { kind: 'rollback'; version: number }
  /** The version the browser has already. */
  | { kind: 'same'; version: number }
  /** Not a vault, or one that does not open or read: changed on the way, or not for this key. */
  | { kind: 'bad' }
  /** A payload this extension is too old to read. */
  | { kind: 'newer-format' };

export async function assess(blob: Bytes, accepted: number, key: Bytes, id: Bytes): Promise<Assessment> {
  let version: number;
  try {
    version = blobVersion(blob);
  } catch {
    return { kind: 'bad' };
  }
  if (version < accepted) return { kind: 'rollback', version };
  if (version === accepted) return { kind: 'same', version };
  let json: string;
  try {
    json = (await openVault(key, id, blob, { minVersion: accepted })).json;
  } catch {
    return { kind: 'bad' };
  }
  try {
    const { payload, skipped } = parsePayload(json);
    return { kind: 'accept', version, payload, skipped };
  } catch (error) {
    return error instanceof ProtocolError && error.code === 'unsupported_version' ? { kind: 'newer-format' } : { kind: 'bad' };
  }
}

/** The payload of a vault already accepted, or null if it no longer reads. */
export async function readVault(blob: Bytes, key: Bytes, id: Bytes): Promise<{ payload: Payload; skipped: number } | null> {
  try {
    return parsePayload((await openVault(key, id, blob)).json);
  } catch {
    return null;
  }
}
