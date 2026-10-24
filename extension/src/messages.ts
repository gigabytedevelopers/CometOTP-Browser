// Messages between the extension's pages and its background.
import { isUsageEvent, type UsageEvent } from './usage/measurement.js';

/** Asks the background whether it is running. */
export interface Ping {
  type: 'ping';
}

/** The background's answer to a ping, with the extension's version. */
export interface Pong {
  type: 'pong';
  version: string;
}

/** Asks the background to count something, if usage statistics are on (src/usage/usage.ts). */
export interface Usage {
  type: 'usage';
  event: UsageEvent;
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

export function isUsage(value: unknown): value is Usage {
  return isObject(value) && value.type === 'usage' && isUsageEvent(value.event);
}
