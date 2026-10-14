// Messages between the extension's pages and its background.

/** Asks the background whether it is running. */
export interface Ping {
  type: 'ping';
}

/** The background's answer to a ping, with the extension's version. */
export interface Pong {
  type: 'pong';
  version: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isPing(value: unknown): value is Ping {
  return isObject(value) && value.type === 'ping';
}

export function isPong(value: unknown): value is Pong {
  return isObject(value) && value.type === 'pong' && typeof value.version === 'string';
}
