// The browser's side of pairing (protocol §3.4), apart from the page that shows it. It shows a
// code, and a new one each time the last expires unanswered. Then it checks the phone's hello, and
// shows the six digits until the person confirms or cancels, while watching for the phone
// cancelling. Last, it sends the confirm, stores the vault's details, says done, and downloads the
// vault. Anything that goes wrong ends it with a reason the page can explain.
import {
  CHANNEL_LIFETIME,
  HELLO_WINDOW,
  TO_BROWSER,
  TO_PHONE,
  derivePairingKeys,
  ecdh,
  formatPairingUri,
  generateKeyPair,
  helloPhonePublicKey,
  openPairingFrame,
  pairingTranscript,
  randomBytes,
  sealPairingFrame,
  type Bytes,
  type PairingCode,
  type PairingKeys,
  type PairingMessage,
} from '@cometotp/protocol';

import { RelayError, type ChannelMessage } from '../sync/relay.js';

export type PairingFailure =
  /** The relay could not be reached, or would not make a channel. */
  | 'unreachable'
  /** The person cancelled on the phone. */
  | 'cancelled-on-phone'
  /** The person cancelled here. */
  | 'cancelled'
  /** The channel's time ran out before the phone finished. */
  | 'expired'
  /** A message did not open or broke the protocol: someone else may have answered the code. */
  | 'broken'
  /** The vault's details could not be kept, for instance because the extension locked itself. */
  | 'not-stored';

export type PairingStep =
  | { step: 'code'; uri: string; expiresAt: number }
  | { step: 'compare'; sas: string; phone: string }
  | { step: 'finishing'; phone: string }
  | { step: 'done'; phone: string; services: number | null }
  | { step: 'failed'; reason: PairingFailure };

/** The relay calls pairing makes (src/sync/relay.ts). */
export interface PairingRelay {
  createChannel(relay: string, channel: Bytes): Promise<string>;
  receive(relay: string, channel: Bytes, token: string, after: number, signal?: AbortSignal): Promise<ChannelMessage[]>;
  send(relay: string, channel: Bytes, token: string, frame: Bytes): Promise<void>;
  deleteChannel(relay: string, channel: Bytes, token: string): Promise<void>;
}

/** The vault's details from the phone, and the phone's name. */
export interface Paired {
  relay: string;
  vault: { id: string; read: string; key: string };
  phone: string;
}

export interface PairingOptions {
  relay: string;
  /** How the phone will show this browser, such as "Chrome on macOS". */
  browserName: string;
  api: PairingRelay;
  /** Keeps the vault's details; throws if it cannot. */
  store(paired: Paired): Promise<void>;
  /** Downloads the vault once paired; the number of services in it, or null when not yet. */
  download(): Promise<number | null>;
  onStep(step: PairingStep): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

class Stop extends Error {
  constructor(readonly reason: PairingFailure) {
    super(reason);
  }
}

const isRelayError = (error: unknown, code?: string): error is RelayError =>
  error instanceof RelayError && (code === undefined || error.code === code);

export class BrowserPairing {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly abort = new AbortController();
  private decide: ((confirmed: boolean) => void) | null = null;
  private decision: boolean | null = null;
  private channel: { id: Bytes; token: string; keys?: PairingKeys; sent: number } | null = null;
  /** The browser's ephemeral private key, until pairing is over. */
  private privateKey: CryptoKey | undefined;
  private finished = false;

  constructor(private readonly options: PairingOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The person checked that the phone shows the same digits. */
  confirm(): void {
    this.decision ??= true;
    this.decide?.(true);
  }

  /** The person cancelled. */
  cancel(): void {
    this.decision ??= false;
    this.decide?.(false);
    this.abort.abort();
  }

  /** Runs the pairing to its end; every outcome is reported through onStep. */
  async run(): Promise<void> {
    try {
      await this.pair();
    } catch (error) {
      const reason: PairingFailure =
        error instanceof Stop
          ? error.reason
          : this.decision === false
            ? 'cancelled'
            : isRelayError(error, 'expired') || isRelayError(error, 'not_found')
              ? 'expired'
              : isRelayError(error)
                ? 'unreachable'
                : 'broken';
      await this.closeChannel(reason !== 'cancelled-on-phone' && reason !== 'expired');
      this.options.onStep({ step: 'failed', reason });
    }
  }

  private async pair(): Promise<void> {
    const { relay, api, onStep } = this.options;
    let code: PairingCode;
    let hello: Bytes;
    let createdAt: number;
    for (;;) {
      if (this.decision === false) throw new Stop('cancelled');
      const browser = await generateKeyPair();
      code = { relay, channel: randomBytes(16), browserPublicKey: browser.publicKey, secret: randomBytes(32), browserName: this.options.browserName };
      let token: string;
      try {
        token = await api.createChannel(relay, code.channel);
      } catch (error) {
        if (isRelayError(error, 'exists')) continue;
        throw new Stop('unreachable');
      }
      this.channel = { id: code.channel, token, sent: 0 };
      createdAt = this.now();
      const expiresAt = createdAt + HELLO_WINDOW * 1000;
      onStep({ step: 'code', uri: formatPairingUri(code), expiresAt });
      const first = await this.next(1, expiresAt);
      if (first) {
        hello = first;
        this.privateKey = browser.privateKey;
        break;
      }
      // Unanswered: a new code, on a new channel.
      await this.closeChannel(false);
    }

    const phoneKey = helloPhonePublicKey(hello);
    const keys = await derivePairingKeys(await ecdh(this.privateKey!, phoneKey), code.secret, await pairingTranscript(code, phoneKey));
    this.channel!.keys = keys;
    const greeting = await this.open(1, hello);
    if (greeting.t !== 'hello') throw new Stop('broken');
    const phone = greeting.phone;
    onStep({ step: 'compare', sas: keys.sas, phone });

    // The person decides while the phone may cancel; its next message is watched meanwhile.
    const lifetimeEnd = createdAt + CHANNEL_LIFETIME * 1000;
    const second = this.next(2, lifetimeEnd);
    // Awaited below; marked handled here so that a cancel meanwhile is not an unhandled rejection.
    second.catch(() => undefined);
    const decided = new Promise<boolean>((resolve) => {
      this.decide = resolve;
      if (this.decision !== null) resolve(this.decision);
    });
    const early = await Promise.race([decided.then(() => null), second]);
    if (early) {
      // The phone sends its vault only after the confirm, so before it only a cancel makes sense.
      throw new Stop((await this.open(2, early)).t === 'cancel' ? 'cancelled-on-phone' : 'broken');
    }
    // Nothing came and nobody decided: the channel's lifetime ran out while the digits were shown.
    if (this.decision === null) throw new Stop('expired');
    if (!(await decided)) throw new Stop('cancelled');

    await this.post({ t: 'confirm' });
    onStep({ step: 'finishing', phone });
    const reply = await second;
    if (!reply) throw new Stop('expired');
    const message = await this.open(2, reply);
    if (message.t === 'cancel') throw new Stop('cancelled-on-phone');
    if (message.t !== 'vault') throw new Stop('broken');

    try {
      await this.options.store({ relay, vault: { id: message.id, read: message.read, key: message.key }, phone });
    } catch {
      throw new Stop('not-stored');
    }
    await this.post({ t: 'done' });
    this.finished = true;
    await this.closeChannel(false);
    this.privateKey = undefined;
    const services = await this.options.download().catch(() => null);
    onStep({ step: 'done', phone, services });
  }

  /** The frame of the phone's message `index`, or null if none came before `deadline`. */
  private async next(index: number, deadline: number): Promise<Bytes | null> {
    const { relay, api } = this.options;
    const channel = this.channel!;
    while (this.now() < deadline) {
      if (this.abort.signal.aborted) throw new Stop('cancelled');
      const started = this.now();
      const messages = await api.receive(relay, channel.id, channel.token, index - 1, this.abort.signal);
      const message = messages[0];
      if (message) {
        if (message.seq !== index) throw new Stop('broken');
        return message.frame;
      }
      // A relay that answers at once rather than waiting is not asked flat out.
      if (this.now() - started < 1000) await this.sleep(1000);
    }
    return null;
  }

  private async open(index: number, frame: Bytes): Promise<PairingMessage> {
    try {
      return await openPairingFrame(this.channel!.keys!, this.channel!.id, TO_BROWSER, index, frame);
    } catch {
      throw new Stop('broken');
    }
  }

  private async post(message: PairingMessage): Promise<void> {
    const channel = this.channel!;
    const frame = await sealPairingFrame(channel.keys!, channel.id, TO_PHONE, channel.sent + 1, message);
    await this.options.api.send(this.options.relay, channel.id, channel.token, frame);
    channel.sent++;
  }

  /** Ends the channel, first telling the phone the pairing is off when `tellPhone`. */
  private async closeChannel(tellPhone: boolean): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    this.channel = null;
    if (tellPhone && channel.keys && !this.finished) {
      try {
        const frame = await sealPairingFrame(channel.keys, channel.id, TO_PHONE, channel.sent + 1, { t: 'cancel' });
        await this.options.api.send(this.options.relay, channel.id, channel.token, frame);
      } catch {
        // The phone learns from the channel ending instead.
      }
    }
    await this.options.api.deleteChannel(this.options.relay, channel.id, channel.token).catch(() => undefined);
  }
}
