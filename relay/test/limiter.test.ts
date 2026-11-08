// The rate limiter on its own: which addresses count as one client, and how much it remembers.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RateLimiter, clientPrefix } from '../src/limiter.js';

const HOUR = 60 * 60 * 1000;

describe('clientPrefix', () => {
  it('keeps an IPv4 address whole', () => {
    assert.equal(clientPrefix('203.0.113.7'), '203.0.113.7');
  });

  it('takes the /64 of an IPv6 address, however it is written', () => {
    for (const address of [
      '2001:db8:1:2::1',
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '2001:0DB8:0001:0002:0000:0000:0000:0000',
      '2001:db8:1:2::',
      '2001:db8:1:2:0:0:192.0.2.1',
    ]) {
      assert.equal(clientPrefix(address), '2001:db8:1:2::/64', address);
    }
    assert.equal(clientPrefix('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(clientPrefix('::1'), '0:0:0:0::/64');
    assert.equal(clientPrefix('::'), '0:0:0:0::/64');
    assert.equal(clientPrefix('fe80::1%eth0'), 'fe80:0:0:0::/64');
  });

  it('counts IPv4 written as IPv6 as IPv4, not as one /64 for everyone', () => {
    assert.equal(clientPrefix('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(clientPrefix('::FFFF:c000:0201'), '192.0.2.1');
    assert.equal(clientPrefix('0:0:0:0:0:ffff:203.0.113.255'), '203.0.113.255');
  });

  it('leaves anything else alone', () => {
    assert.equal(clientPrefix('unknown'), 'unknown');
    assert.equal(clientPrefix('2001:db8::1::2'), '2001:db8::1::2');
  });
});

describe('RateLimiter', () => {
  it('gives every address in a /64 one allowance', () => {
    const limiter = new RateLimiter();
    assert.equal(limiter.addressId('2001:db8:1:2::1'), limiter.addressId('2001:db8:1:2:abcd::99'));
    assert.notEqual(limiter.addressId('2001:db8:1:2::1'), limiter.addressId('2001:db8:1:3::1'));
    assert.equal(limiter.addressId('::ffff:192.0.2.1'), limiter.addressId('192.0.2.1'));
    assert.notEqual(limiter.addressId('192.0.2.1'), limiter.addressId('192.0.2.2'));
  });

  it('allows the limit each hour, then says when to come back', () => {
    const limiter = new RateLimiter();
    assert.equal(limiter.hit('a', 2, 0), 0);
    assert.equal(limiter.hit('a', 2, 1000), 0);
    assert.equal(limiter.hit('a', 2, 2000), HOUR / 1000 - 2);
    assert.equal(limiter.hit('a', 2, HOUR), 0);
  });

  it('keeps no more windows than it may, forgetting the one that started first', () => {
    const limiter = new RateLimiter(3);
    for (const key of ['a', 'b', 'c']) assert.equal(limiter.hit(key, 1, 0), 0);
    for (const key of ['a', 'b', 'c']) assert.ok(limiter.hit(key, 1, 1) > 0, key);
    assert.equal(limiter.hit('d', 1, 2), 0);
    // 'a' made room for 'd', so it starts over; that in turn pushes out 'b'.
    assert.equal(limiter.hit('a', 1, 3), 0);
    assert.ok(limiter.hit('c', 1, 4) > 0);
    assert.ok(limiter.hit('d', 1, 5) > 0);
    assert.equal(limiter.hit('b', 1, 6), 0);
  });

  it('keeps windows in the order they started, so an ended one makes room before a live one', () => {
    const limiter = new RateLimiter(3);
    assert.equal(limiter.hit('a', 1, 0), 0);
    assert.equal(limiter.hit('b', 1, 1), 0);
    // 'a' starts again, so after 'b', which has ended by the time 'd' needs room.
    assert.equal(limiter.hit('a', 1, HOUR), 0);
    assert.equal(limiter.hit('c', 1, HOUR + 1), 0);
    assert.equal(limiter.hit('d', 1, HOUR + 2), 0);
    assert.ok(limiter.hit('a', 1, HOUR + 3) > 0);
  });
});
