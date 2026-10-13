import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * Everything the relay keeps, in SQLite: vaults (ciphertext and token hashes), the ids of deleted
 * vaults, and pairing channels with their messages (protocol §6). No IP address, token or
 * plaintext is ever stored.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Vault {
  id: string;
  writeHash: Uint8Array;
  readHash: Uint8Array;
  version: number;
  blob: Uint8Array | null;
  createdAt: number;
  /** UTC day number (days since the epoch) of the last download; null if never. */
  lastReadDay: number | null;
}

export interface Channel {
  id: string;
  browserHash: Uint8Array;
  phoneHash: Uint8Array | null;
  createdAt: number;
  deleted: boolean;
}

export interface Message {
  seq: number;
  body: Uint8Array;
}

export interface HousekeepingResult {
  vaultsDeleted: number;
  tombstonesDropped: number;
  channelsDropped: number;
}

/** The day, YYYY-MM-DD, of a UTC day number. */
export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function dayNumber(time: number): number {
  return Math.floor(time / DAY_MS);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  write_hash BLOB NOT NULL,
  read_hash BLOB NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  blob BLOB,
  created_at INTEGER NOT NULL,
  last_read_day INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS vault_tombstones (
  id_hash BLOB PRIMARY KEY,
  deleted_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  browser_hash BLOB NOT NULL,
  phone_hash BLOB,
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  channel TEXT NOT NULL,
  direction INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY (channel, direction, seq)
) STRICT;
`;

function bytes(value: unknown): Uint8Array {
  return new Uint8Array(value as Uint8Array);
}

/** SHA-256 of a vault id, under which a deleted vault is remembered. */
function idHash(id: string): Uint8Array {
  return createHash('sha256').update(id).digest();
}

export class RelayStore {
  private readonly db: DatabaseSync;
  private readonly statements: Record<string, StatementSync>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const prepare = (sql: string) => this.db.prepare(sql);
    this.statements = {
      getVault: prepare('SELECT * FROM vaults WHERE id = ?'),
      insertVault: prepare('INSERT INTO vaults (id, write_hash, read_hash, created_at) VALUES (?, ?, ?, ?)'),
      putBlob: prepare('UPDATE vaults SET version = ?, blob = ? WHERE id = ?'),
      markRead: prepare('UPDATE vaults SET last_read_day = ? WHERE id = ?'),
      deleteVault: prepare('DELETE FROM vaults WHERE id = ?'),
      isTombstone: prepare('SELECT 1 FROM vault_tombstones WHERE id_hash = ?'),
      insertTombstone: prepare('INSERT OR REPLACE INTO vault_tombstones (id_hash, deleted_at) VALUES (?, ?)'),
      getChannel: prepare('SELECT * FROM channels WHERE id = ?'),
      insertChannel: prepare('INSERT INTO channels (id, browser_hash, created_at) VALUES (?, ?, ?)'),
      claimChannel: prepare('UPDATE channels SET phone_hash = ? WHERE id = ? AND phone_hash IS NULL'),
      deleteChannel: prepare('UPDATE channels SET deleted = 1 WHERE id = ?'),
      countMessages: prepare('SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND direction = ?'),
      insertMessage: prepare('INSERT INTO messages (channel, direction, seq, body) VALUES (?, ?, ?, ?)'),
      messagesAfter: prepare(
        'SELECT seq, body FROM messages WHERE channel = ? AND direction = ? AND seq > ? ORDER BY seq',
      ),
      staleVaults: prepare(
        `SELECT id FROM vaults
         WHERE (last_read_day IS NULL AND created_at <= ?) OR (last_read_day IS NOT NULL AND last_read_day <= ?)`,
      ),
      dropTombstones: prepare('DELETE FROM vault_tombstones WHERE deleted_at <= ?'),
      oldChannels: prepare('SELECT id FROM channels WHERE created_at <= ?'),
      dropChannel: prepare('DELETE FROM channels WHERE id = ?'),
      dropMessages: prepare('DELETE FROM messages WHERE channel = ?'),
    };
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /* Vaults */

  getVault(id: string): Vault | null {
    const row = this.statements.getVault!.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id,
      writeHash: bytes(row.write_hash),
      readHash: bytes(row.read_hash),
      version: Number(row.version),
      blob: row.blob === null ? null : bytes(row.blob),
      createdAt: Number(row.created_at),
      lastReadDay: row.last_read_day === null ? null : Number(row.last_read_day),
    };
  }

  isDeletedVault(id: string): boolean {
    return this.statements.isTombstone!.get(idHash(id)) !== undefined;
  }

  /** False if the id is taken or belonged to a deleted vault. */
  createVault(id: string, writeHash: Uint8Array, readHash: Uint8Array, now: number): boolean {
    return this.transaction(() => {
      if (this.statements.getVault!.get(id) || this.isDeletedVault(id)) return false;
      this.statements.insertVault!.run(id, writeHash, readHash, now);
      return true;
    });
  }

  /** Stores [blob] as [version] unless the stored version is as high; returns the stored version then. */
  putBlob(id: string, version: number, blob: Uint8Array): { stored: boolean; version: number } {
    return this.transaction(() => {
      const current = this.getVault(id);
      if (!current) throw new Error('No such vault');
      if (version <= current.version) return { stored: false, version: current.version };
      this.statements.putBlob!.run(version, blob, id);
      return { stored: true, version };
    });
  }

  markRead(id: string, now: number): void {
    this.statements.markRead!.run(dayNumber(now), id);
  }

  deleteVault(id: string, now: number): void {
    this.transaction(() => {
      this.statements.deleteVault!.run(id);
      this.statements.insertTombstone!.run(idHash(id), now);
    });
  }

  /* Channels */

  getChannel(id: string): Channel | null {
    const row = this.statements.getChannel!.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id,
      browserHash: bytes(row.browser_hash),
      phoneHash: row.phone_hash === null ? null : bytes(row.phone_hash),
      createdAt: Number(row.created_at),
      deleted: Number(row.deleted) === 1,
    };
  }

  /** False if the id is in use, or was within its lifetime and the grace after it. */
  createChannel(id: string, browserHash: Uint8Array, now: number): boolean {
    return this.transaction(() => {
      if (this.statements.getChannel!.get(id)) return false;
      this.statements.insertChannel!.run(id, browserHash, now);
      return true;
    });
  }

  /** Claims the channel for a phone and stores its first message; false if already claimed. */
  claimChannel(id: string, phoneHash: Uint8Array, direction: number, body: Uint8Array): boolean {
    return this.transaction(() => {
      const changed = this.statements.claimChannel!.run(phoneHash, id).changes;
      if (Number(changed) !== 1) return false;
      this.statements.insertMessage!.run(id, direction, 1, body);
      return true;
    });
  }

  /** Appends a message; returns its seq, or null when the direction already holds [max]. */
  addMessage(id: string, direction: number, body: Uint8Array, max: number): number | null {
    return this.transaction(() => {
      const count = Number((this.statements.countMessages!.get(id, direction) as { n: number }).n);
      if (count >= max) return null;
      this.statements.insertMessage!.run(id, direction, count + 1, body);
      return count + 1;
    });
  }

  messagesAfter(id: string, direction: number, after: number): Message[] {
    const rows = this.statements.messagesAfter!.all(id, direction, after) as Record<string, unknown>[];
    return rows.map((row) => ({ seq: Number(row.seq), body: bytes(row.body) }));
  }

  deleteChannel(id: string): void {
    this.statements.deleteChannel!.run(id);
  }

  /* Housekeeping (protocol §6.4) */

  housekeeping(now: number, channelKeepMs: number): HousekeepingResult {
    return this.transaction(() => {
      const today = dayNumber(now);
      const stale = this.statements.staleVaults!.all(now - 7 * DAY_MS, today - 180) as { id: string }[];
      for (const { id } of stale) {
        this.statements.deleteVault!.run(id);
        this.statements.insertTombstone!.run(idHash(id), now);
      }
      const tombstones = Number(this.statements.dropTombstones!.run(now - 180 * DAY_MS).changes);
      const channels = this.statements.oldChannels!.all(now - channelKeepMs) as { id: string }[];
      for (const { id } of channels) {
        this.statements.dropMessages!.run(id);
        this.statements.dropChannel!.run(id);
      }
      return { vaultsDeleted: stale.length, tombstonesDropped: tombstones, channelsDropped: channels.length };
    });
  }
}
