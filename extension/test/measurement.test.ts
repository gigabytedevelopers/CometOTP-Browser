// Usage statistics as Google Analytics receives them (src/usage/measurement.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENDPOINT,
  MEASUREMENT_ID,
  SESSION_MS,
  USAGE_EVENTS,
  collectUrl,
  isSession,
  isUsageEvent,
  measurement,
  newClientId,
  nextSession,
} from '../src/usage/measurement.js';

describe('usage statistics', () => {
  it('counts only opening the popup, copying and filling codes, pairing and disconnecting', () => {
    assert.deepEqual(USAGE_EVENTS, ['popup_opened', 'code_copied', 'code_filled', 'browser_paired', 'browser_disconnected']);
    for (const event of USAGE_EVENTS) assert.ok(isUsageEvent(event), event);
    for (const other of ['page_view', 'service_added', '', 1, null, undefined]) assert.equal(isUsageEvent(other), false, String(other));
  });

  it("sends to the stream's EU endpoint", () => {
    assert.equal(ENDPOINT, 'https://region1.google-analytics.com/mp/collect');
    assert.match(MEASUREMENT_ID, /^G-[A-Z0-9]{10}$/);
    const url = new URL(collectUrl());
    assert.equal(`${url.origin}${url.pathname}`, ENDPOINT);
    assert.equal(url.searchParams.get('measurement_id'), MEASUREMENT_ID);
    assert.ok(url.searchParams.has('api_secret'));
  });

  it('keeps a session going while events come within 30 minutes of each other', () => {
    const start = Date.UTC(2026, 9, 24, 12);
    const first = nextSession(null, start);
    assert.deepEqual(first, { id: String(start / 1000), last: start });
    const later = nextSession(first, start + SESSION_MS - 1);
    assert.deepEqual(later, { id: first.id, last: start + SESSION_MS - 1 });
    // After a pause, or when the clock went back, a new one begins.
    assert.notEqual(nextSession(later, later.last + SESSION_MS).id, first.id);
    assert.equal(nextSession(later, start - 60_000).id, String((start - 60_000) / 1000));
    assert.ok(isSession(first));
    assert.equal(isSession({ id: 1, last: start }), false);
    assert.equal(isSession(null), false);
  });

  it('makes a new random id each time they are turned on', () => {
    const a = newClientId();
    assert.match(a, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(newClientId(), a);
  });

  it('sends the event with the version, the browser and the session, and denies consent for ads', () => {
    const body = JSON.parse(measurement('id', { id: '1792850000', last: 0 }, 'code_copied', '1.2.3', 'firefox')) as unknown;
    assert.deepEqual(body, {
      client_id: 'id',
      non_personalized_ads: true,
      consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
      events: [
        {
          name: 'code_copied',
          params: { session_id: '1792850000', engagement_time_msec: 100, app_version: '1.2.3', browser: 'firefox' },
        },
      ],
    });
  });
});
