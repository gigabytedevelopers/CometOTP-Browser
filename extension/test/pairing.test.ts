// The browser's side of pairing (src/pair/pairing.ts) against a relay kept in memory and a phone
// that does its side with the protocol package, as CometOTP does: the happy path, a code that
// expires unanswered, and every way it can fail.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TO_BROWSER,
  TO_PHONE,
  derivePairingKeys,
  ecdh,
  generateKeyPair,
  openPairingFrame,
  pairingTranscript,
  parsePairingUri,
  randomBytes,
  sealPairingFrame,
  toBase64Url,
  type Bytes,
  type PairingKeys,
  type PairingMessage,
} from '@cometotp/protocol';

import { BrowserPairing, type Paired, type PairingRelay, type PairingStep } from '../src/pair/pairing.js';
import { RelayError } from '../src/sync/relay.js';

const RELAY = 'https://relay.example.com';

type PhoneBehaviour = {
  /** Which codes it answers, by their number, from 1. */
  answers?: (code: number) => boolean;
  /** What it does once it has said hello. */
  afterHello?: 'wait' | 'cancel' | 'vault-early';
  /** What it does on the browser's confirm. */
  onConfirm?: 'vault' | 'cancel' | 'nothing';
  tamperHello?: boolean;
};

/** A relay channel, and the phone on the other end of it. */
class Channel {
  toBrowser: Bytes[] = [];
  toPhone: Bytes[] = [];
  deleted = false;
  keys?: PairingKeys;
  constructor(readonly token: string) {}
}

class World implements PairingRelay {
  channels = new Map<string, Channel>();
  clock = 1_000_000;
  codes = 0;
  steps: PairingStep[] = [];
  stored: Paired[] = [];
  received: PairingMessage[] = [];
  unreachable = false;
  /** The phone scanning the latest code; polls wait for it, as a real relay's long poll would. */
  private scanning: Promise<void> = Promise.resolve();

  constructor(private readonly phone: PhoneBehaviour = {}) {}

  private channel(id: Bytes): Channel {
    const channel = this.channels.get(toBase64Url(id));
    if (!channel || channel.deleted) throw new RelayError(410, 'expired');
    return channel;
  }

  async createChannel(_relay: string, id: Bytes): Promise<string> {
    if (this.unreachable) throw new RelayError(0, 'unreachable');
    const token = toBase64Url(randomBytes(32));
    this.channels.set(toBase64Url(id), new Channel(token));
    return token;
  }

  async receive(_relay: string, id: Bytes, token: string, after: number) {
    await this.scanning;
    const channel = this.channel(id);
    assert.equal(token, channel.token);
    return channel.toBrowser.slice(after).map((frame, i) => ({ seq: after + i + 1, frame }));
  }

  async send(_relay: string, id: Bytes, token: string, frame: Bytes): Promise<void> {
    const channel = this.channel(id);
    assert.equal(token, channel.token);
    channel.toPhone.push(frame);
    const message = await openPairingFrame(channel.keys!, id, TO_PHONE, channel.toPhone.length, frame);
    this.received.push(message);
    if (message.t === 'confirm') {
      if ((this.phone.onConfirm ?? 'vault') === 'vault') await this.phoneSends(channel, id, this.vault());
      else if (this.phone.onConfirm === 'cancel') await this.phoneSends(channel, id, { t: 'cancel' });
    }
  }

  async deleteChannel(_relay: string, id: Bytes): Promise<void> {
    const channel = this.channels.get(toBase64Url(id));
    if (channel) channel.deleted = true;
  }

  private vault(): PairingMessage {
    return { t: 'vault', id: toBase64Url(randomBytes(16)), read: toBase64Url(randomBytes(32)), key: toBase64Url(randomBytes(32)) };
  }

  private async phoneSends(channel: Channel, id: Bytes, message: PairingMessage): Promise<void> {
    channel.toBrowser.push(await sealPairingFrame(channel.keys!, id, TO_BROWSER, channel.toBrowser.length + 1, message));
  }

  /** The phone scans the code: it claims the channel with its hello. */
  async scan(uri: string): Promise<void> {
    const code = parsePairingUri(uri);
    const channel = this.channel(code.channel);
    const phone = await generateKeyPair();
    channel.keys = await derivePairingKeys(await ecdh(phone.privateKey, code.browserPublicKey), code.secret, await pairingTranscript(code, phone.publicKey));
    const hello = await sealPairingFrame(channel.keys, code.channel, TO_BROWSER, 1, { t: 'hello', phone: 'Pixel 7' }, phone.publicKey);
    if (this.phone.tamperHello) hello[hello.length - 1]! ^= 1;
    channel.toBrowser.push(hello);
    if (this.phone.afterHello === 'cancel') await this.phoneSends(channel, code.channel, { t: 'cancel' });
    if (this.phone.afterHello === 'vault-early') await this.phoneSends(channel, code.channel, this.vault());
  }

  pairing(decide?: (pairing: BrowserPairing, step: PairingStep) => void, store?: (paired: Paired) => Promise<void>): BrowserPairing {
    const pairing: BrowserPairing = new BrowserPairing({
      relay: RELAY,
      browserName: 'Chrome on macOS',
      api: this,
      store: store ?? (async (paired) => void this.stored.push(paired)),
      download: async () => 3,
      onStep: (step) => {
        this.steps.push(step);
        if (step.step === 'code' && (this.phone.answers ?? (() => true))(++this.codes)) this.scanning = this.scan(step.uri);
        (decide ?? ((p, s) => s.step === 'compare' && p.confirm()))(pairing, step);
      },
      now: () => this.clock,
      // Time passes at once, but the event loop still turns, as WebCrypto needs it to.
      sleep: async (ms) => {
        this.clock += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    return pairing;
  }

  last(): PairingStep {
    return this.steps.at(-1)!;
  }
}

describe('pairing, the browser side', () => {
  it('pairs: code, the same six digits as the phone, confirm, vault, done', async () => {
    const world = new World();
    await world.pairing().run();
    assert.deepEqual(world.steps.map((s) => s.step), ['code', 'compare', 'finishing', 'done']);
    const compare = world.steps[1] as Extract<PairingStep, { step: 'compare' }>;
    const channel = [...world.channels.values()][0]!;
    assert.equal(compare.sas, channel.keys!.sas);
    assert.equal(compare.phone, 'Pixel 7');
    assert.deepEqual(world.received.map((m) => m.t), ['confirm', 'done']);
    assert.equal(world.stored.length, 1);
    assert.equal(world.stored[0]!.relay, RELAY);
    assert.equal(world.stored[0]!.phone, 'Pixel 7');
    assert.deepEqual(world.last(), { step: 'done', phone: 'Pixel 7', services: 3 });
    assert.ok(channel.deleted);
  });

  it('shows a new code on a new channel when one expires unanswered', async () => {
    const world = new World({ answers: (code) => code === 2 });
    await world.pairing().run();
    const codes = world.steps.filter((s) => s.step === 'code') as Extract<PairingStep, { step: 'code' }>[];
    assert.equal(codes.length, 2);
    assert.notEqual(codes[0]!.uri, codes[1]!.uri);
    assert.equal(codes[1]!.expiresAt - codes[0]!.expiresAt >= 120_000, true);
    const [first] = world.channels.values();
    assert.ok(first!.deleted);
    assert.equal(world.last().step, 'done');
  });

  it('stops when the person cancels, telling the phone', async () => {
    const world = new World();
    await world.pairing((pairing, step) => step.step === 'compare' && pairing.cancel()).run();
    assert.deepEqual(world.last(), { step: 'failed', reason: 'cancelled' });
    assert.deepEqual(world.received.map((m) => m.t), ['cancel']);
    assert.equal(world.stored.length, 0);
    assert.ok([...world.channels.values()][0]!.deleted);
  });

  it('stops when the phone cancels, while the person is still comparing', async () => {
    const world = new World({ afterHello: 'cancel' });
    await world.pairing(() => undefined).run();
    assert.deepEqual(world.last(), { step: 'failed', reason: 'cancelled-on-phone' });
    assert.equal(world.stored.length, 0);
  });

  it('stops when the phone cancels instead of sending the vault', async () => {
    const world = new World({ onConfirm: 'cancel' });
    await world.pairing().run();
    assert.deepEqual(world.last(), { step: 'failed', reason: 'cancelled-on-phone' });
    assert.equal(world.stored.length, 0);
  });

  it('refuses a hello that does not open, and a vault sent before the confirm', async () => {
    for (const behaviour of [{ tamperHello: true }, { afterHello: 'vault-early' as const }]) {
      const world = new World(behaviour);
      await world.pairing(() => undefined).run();
      assert.deepEqual(world.last(), { step: 'failed', reason: 'broken' }, JSON.stringify(behaviour));
      assert.equal(world.stored.length, 0);
    }
  });

  it('gives up when the phone never sends the vault within the channel lifetime', async () => {
    const world = new World({ onConfirm: 'nothing' });
    await world.pairing().run();
    assert.deepEqual(world.last(), { step: 'failed', reason: 'expired' });
    assert.equal(world.stored.length, 0);
  });

  it('gives up when the person never decides within the channel lifetime', async () => {
    const world = new World();
    await world.pairing(() => undefined).run();
    assert.deepEqual(world.last(), { step: 'failed', reason: 'expired' });
    assert.deepEqual(world.received, []);
    assert.equal(world.stored.length, 0);
  });

  it('says so when the relay cannot be reached', async () => {
    const world = new World();
    world.unreachable = true;
    await world.pairing().run();
    assert.deepEqual(world.steps, [{ step: 'failed', reason: 'unreachable' }]);
  });

  it('tells the phone it is off when the vault details cannot be kept', async () => {
    const world = new World();
    await world
      .pairing(undefined, async () => {
        throw new Error('Locked');
      })
      .run();
    assert.deepEqual(world.last(), { step: 'failed', reason: 'not-stored' });
    assert.deepEqual(world.received.map((m) => m.t), ['confirm', 'cancel']);
  });
});
