/** How the relay runs, from the environment (see relay/README.md). */
export interface RelayConfig {
  port: number;
  host: string;
  /** SQLite file; `:memory:` keeps everything in memory (tests). */
  databasePath: string;
  /**
   * Take the client's address from X-Forwarded-For (its last entry, which the proxy added), for
   * rate limits only. Set it when, and only when, the relay sits behind a reverse proxy that sets
   * that header.
   */
  trustProxy: boolean;
  /** How long a pairing channel GET waits for a message before answering with none. */
  longPollMs: number;
  limits: RateLimits;
  caps: Caps;
  /**
   * The relay's version, from relay/package.json, which GET /v1/ sends as X-Relay-Version so that
   * a deployment can check which one is running. Without it, nothing is sent.
   */
  version?: string;
}

/** Requests allowed per hour (protocol §6.1). */
export interface RateLimits {
  /** Per client address: channels created and claimed. */
  channels: number;
  /** Per client address: vaults created. */
  vaults: number;
  /** Per vault: downloads. */
  downloads: number;
  /** Per vault: uploads. */
  uploads: number;
}

export const DEFAULT_LIMITS: RateLimits = { channels: 30, vaults: 20, downloads: 120, uploads: 240 };

/** The most the relay keeps at once, however many clients ask, so that they cannot fill its disk. */
export interface Caps {
  /** Vaults, with a blob or not yet. */
  vaults: number;
  /** Bytes of vault blobs, all together. */
  vaultBytes: number;
  /** Pairing channels, from when they are made until they are forgotten (§6.4). */
  channels: number;
}

const MB = 1024 * 1024;

export const DEFAULT_CAPS: Caps = { vaults: 100_000, vaultBytes: 2048 * MB, channels: 10_000 };

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    port: integer(env.PORT, 8080, 'PORT'),
    host: env.HOST || '0.0.0.0',
    databasePath: env.DATABASE_PATH || 'relay.sqlite',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    longPollMs: integer(env.LONG_POLL_MS, 25_000, 'LONG_POLL_MS'),
    limits: {
      channels: integer(env.LIMIT_CHANNELS_PER_HOUR, DEFAULT_LIMITS.channels, 'LIMIT_CHANNELS_PER_HOUR'),
      vaults: integer(env.LIMIT_VAULTS_PER_HOUR, DEFAULT_LIMITS.vaults, 'LIMIT_VAULTS_PER_HOUR'),
      downloads: integer(env.LIMIT_DOWNLOADS_PER_HOUR, DEFAULT_LIMITS.downloads, 'LIMIT_DOWNLOADS_PER_HOUR'),
      uploads: integer(env.LIMIT_UPLOADS_PER_HOUR, DEFAULT_LIMITS.uploads, 'LIMIT_UPLOADS_PER_HOUR'),
    },
    caps: {
      vaults: integer(env.MAX_VAULTS, DEFAULT_CAPS.vaults, 'MAX_VAULTS'),
      vaultBytes: integer(env.MAX_VAULT_MB, DEFAULT_CAPS.vaultBytes / MB, 'MAX_VAULT_MB') * MB,
      channels: integer(env.MAX_CHANNELS, DEFAULT_CAPS.channels, 'MAX_CHANNELS'),
    },
  };
}
