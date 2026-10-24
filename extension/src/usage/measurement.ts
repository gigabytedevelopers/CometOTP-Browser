// Usage statistics as Google Analytics receives them, apart from sending them, so they are tested
// on their own (test/measurement.test.ts). They go through the Measurement Protocol, as plain
// requests from the extension's own code: Manifest V3 runs no code from elsewhere, so not gtag.js.
// Only the events named here are sent, each with the extension's version and the browser's
// family, and nothing about the person's services, codes or the sites they use.
import { randomBytes, toBase64Url } from '@cometotp/protocol';

/** The "CometOTP extension" web stream, in Gigabyte Developers' Google Analytics account. */
export const MEASUREMENT_ID = 'G-KE2LZGXEKV';

/**
 * The stream's Measurement Protocol secret, "CometOTP extension". It ships in the package, so
 * anyone could read it and send made-up events, which would skew the numbers and nothing else; it
 * can be replaced in the stream's settings. Empty, nothing can be sent, and the settings do not
 * offer usage statistics.
 */
export const API_SECRET: string = 'vKOa1xECT42yq6z0uTlM-Q';

/** Google's endpoint that collects in the European Union. */
export const ENDPOINT = 'https://region1.google-analytics.com/mp/collect';

/** What may be counted: opening the popup, copying or filling a code, pairing and disconnecting. */
export const USAGE_EVENTS = ['popup_opened', 'code_copied', 'code_filled', 'browser_paired', 'browser_disconnected'] as const;

export type UsageEvent = (typeof USAGE_EVENTS)[number];

export type BrowserFamily = 'chromium' | 'firefox';

/** A session ends after 30 minutes without an event, as in Google Analytics' own tag. */
export const SESSION_MS = 30 * 60_000;

/**
 * Google Analytics counts a user as active only with some engagement time. The extension does not
 * measure it, so each event carries the 100 ms that Chrome's guide to the Measurement Protocol uses.
 */
export const ENGAGEMENT_MS = 100;

export interface Session {
  /** Seconds since the epoch when it began, as text. */
  id: string;
  /** When its last event was, in milliseconds since the epoch. */
  last: number;
}

export function isUsageEvent(value: unknown): value is UsageEvent {
  return typeof value === 'string' && (USAGE_EVENTS as readonly string[]).includes(value);
}

export function isSession(value: unknown): value is Session {
  const s = value as Record<string, unknown> | null;
  return typeof s?.id === 'string' && typeof s.last === 'number';
}

/** The session an event at `now` belongs to: the one before, or a new one after a pause. */
export function nextSession(previous: Session | null, now: number): Session {
  if (previous && now >= previous.last && now - previous.last < SESSION_MS) return { id: previous.id, last: now };
  return { id: String(Math.floor(now / 1000)), last: now };
}

/** A random id for this browser's statistics, made when they are turned on and linked to nothing else. */
export function newClientId(): string {
  return toBase64Url(randomBytes(16));
}

/** Where to send, with the stream's id and secret. */
export function collectUrl(): string {
  return `${ENDPOINT}?measurement_id=${encodeURIComponent(MEASUREMENT_ID)}&api_secret=${encodeURIComponent(API_SECRET)}`;
}

/**
 * The request's body for one event. Consent for advertising is always denied, so Google may not
 * use it for ads, whatever the property's settings.
 */
export function measurement(clientId: string, session: Session, event: UsageEvent, version: string, browser: BrowserFamily): string {
  return JSON.stringify({
    client_id: clientId,
    non_personalized_ads: true,
    consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
    events: [{ name: event, params: { session_id: session.id, engagement_time_msec: ENGAGEMENT_MS, app_version: version, browser } }],
  });
}
