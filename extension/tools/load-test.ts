// Loads each build into a real browser, in a throwaway profile, and checks that it works there:
// the browser accepts it, its popup page opens, and the page reaches the background, which answers
// with the extension's version (src/popup/popup.ts records it in `data-background`). Then it uses
// the lock as a person would, through the popup (see exerciseLock), and in Chrome adds a passkey
// on a virtual authenticator with the PRF extension, on the settings page, and unlocks with it
// (see exercisePasskey). It changes the settings (see exerciseSettings). Last, it pairs with a
// stand-in phone through a relay it starts on this computer (see exercisePairing), fills codes
// into a page it serves (see exerciseFill), then checks the codes against the protocol package's,
// that a change on the phone reaches the popup, and that the phone removing the browser wipes its
// copy (see exerciseSync); it pairs again and disconnects from the browser (see
// exerciseDisconnect).
//
// - Chrome, driven through the DevTools protocol over a pipe: Extensions.loadUnpacked, which
//   needs --enable-unsafe-extension-debugging.
// - Firefox, driven through WebDriver BiDi: webExtension.install, a temporary install as from
//   about:debugging. A preference fixes the extension's moz-extension:// address beforehand, and
//   MOZ_REMOTE_ALLOW_SYSTEM_ACCESS lets the test open that address, which WebDriver otherwise
//   refuses as privileged (the --remote-allow-system-access flag it replaces is gone in 159).
//
// Neither can answer the browser's prompt for access to sites, or click in an extension page as a
// person would, which asking needs. So both load a copy of the build that has access already, as
// if the person had turned filling on (see withSiteAccess).
//
// Usage: node dist/tools/load-test.js [--chrome <path>] [--firefox <path>] [--require-all]
// Without a path, the usual install locations are tried, and a browser that is not found is
// skipped, unless --require-all is given (as in CI).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import {
  TO_BROWSER,
  TO_PHONE,
  buildPayload,
  derivePairingKeys,
  generateCode,
  ecdh,
  fromBase32,
  fromBase64Url,
  generateKeyPair,
  openPairingFrame,
  pairingTranscript,
  parsePairingUri,
  randomBytes,
  sealPairingFrame,
  sealVault,
  serviceId,
  toBase64Url,
  type Bytes,
  type PairingMessage,
  type Service,
} from '@cometotp/protocol';

import { API_SECRET } from '../src/usage/measurement.js';
import { GECKO_ID, type Target } from './manifest.js';
import { EXTENSION_DIR, targetDir, version } from './package.js';

const TIMEOUT_MS = 60_000;
const FIREFOX_UUID = '6b1f2a1e-0d6c-4a52-9a0c-5f8d0c7e4b11';

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function find(explicit: string | undefined, env: string | undefined, candidates: string[]): string | undefined {
  if (explicit) return explicit;
  if (env) return env;
  return candidates.find((path) => existsSync(path));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns something other than undefined, or the time is up. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    // A page being reloaded cannot answer for a moment.
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(250);
  }
}

/** Runs an expression in the popup page and gives back its result if it is a string. */
type Evaluate = (expression: string) => Promise<string | undefined>;

const PASSWORD = 'orbit lantern pickle';

/** Reads a record from the extension's IndexedDB as JSON. */
function readRecord(key: string): string {
  return `(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('cometotp');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const value = await new Promise((resolve, reject) => {
      const req = db.transaction('records').objectStore('records').get(${JSON.stringify(key)});
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return JSON.stringify(value ?? null);
  })()`;
}

/** Writes a record to the extension's IndexedDB, as the extension would. */
function writeRecord(key: string, value: unknown): string {
  return `(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('cometotp');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').put(${JSON.stringify(value)}, ${JSON.stringify(key)});
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return 'written';
  })()`;
}

const READ_LOCK_RECORD = readRecord('lock');

const READ_SESSION_KEY = `(async () => (await chrome.storage.session.get('localKey')).localKey ?? 'none')()`;

function fill(form: string, fields: Record<string, string>): string {
  const sets = Object.entries(fields)
    .map(([id, value]) => `set(${JSON.stringify(id)}, ${JSON.stringify(value)});`)
    .join(' ');
  return `(() => {
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    ${sets}
    document.getElementById(${JSON.stringify(form)}).requestSubmit();
    return 'sent';
  })()`;
}

async function view(evaluate: Evaluate, expected: string): Promise<void> {
  await waitFor(`the popup to show "${expected}"`, async () =>
    (await evaluate('document.body?.dataset.view')) === expected ? true : undefined,
  );
}

/**
 * Uses the lock through the popup, as a person would: sets a password, checks that the local key
 * is only in storage.session and that the record on disk holds neither it nor the password; locks,
 * reloads and checks that nothing is in memory; tries a wrong password; and unlocks again, getting
 * the same key back.
 */
async function exerciseLock(evaluate: Evaluate): Promise<void> {
  await view(evaluate, 'new');
  await evaluate(fill('setup-form', { 'setup-password': PASSWORD, 'setup-confirm': PASSWORD }));
  await view(evaluate, 'unlocked');

  const key = await evaluate(READ_SESSION_KEY);
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error(`No local key in storage.session after setup (${key})`);
  const record = JSON.parse((await evaluate(READ_LOCK_RECORD)) ?? 'null');
  if (record?.v !== 1 || record.kdf?.memory !== 65536 || record.kdf?.passes !== 3) {
    throw new Error(`Unexpected lock record ${JSON.stringify(record)}`);
  }
  const stored = JSON.stringify(record);
  if (stored.includes(key) || stored.includes('lantern')) throw new Error('The lock record gives away the key or the password');

  await evaluate("(() => { document.getElementById('lock').click(); return 'clicked'; })()");
  await view(evaluate, 'locked');
  await evaluate("(() => { location.reload(); return 'reloading'; })()");
  await delay(500);
  await view(evaluate, 'locked');
  if ((await evaluate(READ_SESSION_KEY)) !== 'none') throw new Error('The local key is still in memory after locking');

  await evaluate(fill('unlock-form', { 'unlock-password': 'orbit lantern pickles' }));
  await waitFor('"Wrong password."', async () =>
    (await evaluate("document.getElementById('unlock-error').textContent")) === 'Wrong password.' ? true : undefined,
  );
  if ((await evaluate('document.body.dataset.view')) !== 'locked') throw new Error('A wrong password unlocked it');

  await evaluate(fill('unlock-form', { 'unlock-password': PASSWORD }));
  await view(evaluate, 'unlocked');
  if ((await evaluate(READ_SESSION_KEY)) !== key) throw new Error('Unlocking gave a different local key');
}

const click = (id: string) => `(() => { document.getElementById(${JSON.stringify(id)}).click(); return 'clicked'; })()`;

async function attribute(evaluate: Evaluate, what: string, expression: string, expected: (value: string) => boolean): Promise<string> {
  return waitFor(what, async () => {
    const value = await evaluate(expression);
    return value !== undefined && expected(value) ? value : undefined;
  });
}

/**
 * Starting unlocked: adds a passkey on an authenticator with the PRF extension, locks, and unlocks
 * with the passkey to the same key. Then an authenticator without PRF cannot replace it, and the
 * password still unlocks with the passkey in place.
 */
async function exercisePasskey(
  evaluate: Evaluate,
  open: (path: string) => Promise<void>,
  useAuthenticator: (prf: boolean) => Promise<void>,
): Promise<void> {
  await open('settings/settings.html');
  await attribute(evaluate, 'the settings page', 'document.body.dataset.view', (v) => v === 'unlocked');
  const support = await attribute(evaluate, 'the passkey panel', 'document.body.dataset.passkey', () => true);
  if (support !== 'none') throw new Error(`Passkeys should be offered here, but the settings page says "${support}"`);
  await useAuthenticator(true);
  await evaluate(click('passkey-add'));
  await attribute(evaluate, 'the passkey to be added', 'document.body.dataset.passkey', (v) => v === 'added');
  const key = await evaluate(READ_SESSION_KEY);

  await open('popup/popup.html');
  await view(evaluate, 'unlocked');
  await evaluate(click('lock'));
  await view(evaluate, 'locked');
  // The popup offers the passkey once it has read the lock record, a moment after it shows.
  await attribute(evaluate, 'the locked popup to offer the passkey', "String(document.getElementById('passkey-unlock').hidden)", (v) => v === 'false');
  await evaluate(click('passkey-unlock-submit'));
  await view(evaluate, 'unlocked');
  if ((await evaluate(READ_SESSION_KEY)) !== key) throw new Error('The passkey unlocked to a different local key');

  await useAuthenticator(false);
  await open('settings/settings.html');
  await attribute(evaluate, 'the settings page to offer replacing the passkey', 'document.body.dataset.passkey', (v) => v === 'added');
  await evaluate(click('passkey-add'));
  await attribute(evaluate, 'a passkey without PRF to be refused', "document.getElementById('passkey-error').textContent", (v) =>
    v.includes('cannot unlock'),
  );
  if ((await evaluate('document.body.dataset.passkey')) !== 'added') throw new Error('A refused passkey replaced the one added');

  await open('popup/popup.html');
  await view(evaluate, 'unlocked');
  await evaluate(click('lock'));
  await view(evaluate, 'locked');
  await evaluate(fill('unlock-form', { 'unlock-password': PASSWORD }));
  await view(evaluate, 'unlocked');
  if ((await evaluate(READ_SESSION_KEY)) !== key) throw new Error('The password unlocked to a different local key');
}

const NEW_PASSWORD = 'quartz meadow lantern';
const BROWSER_NAME = 'Load test browser';

/**
 * The settings page: usage statistics are off, with no id kept, as nobody turned them on (the test
 * never turns them on: it would send to Google Analytics). Then choosing how soon it locks (the
 * popup then says so), naming the browser for pairing (the stand-in phone checks the name in
 * exercisePairing), and changing the password: a wrong current one is refused; after the change
 * the old one no longer unlocks and the new one unlocks to the same local key, with the passkey
 * kept. Then it changes the password back.
 */
async function exerciseSettings(evaluate: Evaluate, open: (path: string) => Promise<void>): Promise<void> {
  const select = (minutes: number) =>
    `(() => { const s = document.getElementById('auto-lock'); s.value = '${minutes}'; s.dispatchEvent(new Event('change')); return 'chosen'; })()`;
  await open('settings/settings.html');
  await attribute(evaluate, 'the settings page', 'document.body.dataset.autoLock', (v) => v === '15');
  await attribute(evaluate, 'usage statistics to be off', 'document.body.dataset.usage', (v) => v === (API_SECRET ? 'off' : 'unavailable'));
  if ((await evaluate(readRecord('usage-stats'))) !== 'null') throw new Error('Usage statistics have an id although nobody turned them on');
  const passkey = await evaluate('document.body.dataset.passkey');
  await evaluate(select(5));
  await attribute(evaluate, 'the lock time to be kept', readRecord('auto-lock'), (v) => v === '5');
  await open('popup/popup.html');
  await attribute(evaluate, 'the popup to say when it locks', "document.getElementById('lock-hint').textContent", (v) => v.includes('after 5 minutes'));
  await open('settings/settings.html');
  await attribute(evaluate, 'the settings page', 'document.body.dataset.autoLock', (v) => v === '5');
  await evaluate(select(15));
  await attribute(evaluate, 'the lock time to go back to its default', readRecord('auto-lock'), (v) => v === 'null');

  await evaluate(fill('name-form', { name: ` ${BROWSER_NAME} ` }));
  await attribute(evaluate, 'the name to be saved', "document.getElementById('name-done').textContent", (v) => v === 'Saved.');
  if ((await evaluate(readRecord('browser-name'))) !== JSON.stringify(BROWSER_NAME)) throw new Error('The name was not kept as given');

  const change = (current: string, next: string) =>
    fill('password-form', { 'password-current': current, 'password-new': next, 'password-confirm': next });
  const key = await evaluate(READ_SESSION_KEY);
  await evaluate(change('not the password at all', NEW_PASSWORD));
  await attribute(evaluate, 'a wrong current password to be refused', "document.getElementById('password-error').textContent", (v) =>
    v === 'The current password is wrong.',
  );
  await evaluate(change(PASSWORD, NEW_PASSWORD));
  await attribute(evaluate, 'the password to change', 'document.body.dataset.password', (v) => v === 'changed');
  if ((await evaluate('document.body.dataset.passkey')) !== passkey) throw new Error('Changing the password changed the passkey');

  await open('popup/popup.html');
  await view(evaluate, 'unlocked');
  await evaluate(click('lock'));
  await view(evaluate, 'locked');
  await evaluate(fill('unlock-form', { 'unlock-password': PASSWORD }));
  await attribute(evaluate, 'the old password to be refused', "document.getElementById('unlock-error').textContent", (v) => v === 'Wrong password.');
  await evaluate(fill('unlock-form', { 'unlock-password': NEW_PASSWORD }));
  await view(evaluate, 'unlocked');
  if ((await evaluate(READ_SESSION_KEY)) !== key) throw new Error('The new password unlocked to a different local key');

  await open('settings/settings.html');
  await attribute(evaluate, 'the settings page', 'document.body.dataset.view', (v) => v === 'unlocked');
  await evaluate(change(NEW_PASSWORD, PASSWORD));
  await attribute(evaluate, 'the password to change back', "document.getElementById('password-done').textContent", (v) => v.includes('changed'));
}

/**
 * Disconnect from the browser (protocol §7.2), after pairing again: the settings page deletes the
 * vault on the relay, so the phone's next upload gets 410, and everything the pairing kept here.
 */
async function exerciseDisconnect(evaluate: Evaluate, open: (path: string) => Promise<void>, phone: PhoneVault): Promise<void> {
  await open('settings/settings.html');
  await attribute(evaluate, 'the settings page to offer Disconnect', 'document.body.dataset.paired', (v) => v === 'yes');
  await evaluate(click('disconnect'));
  await evaluate(click('disconnect-yes'));
  await attribute(evaluate, 'the relay to hear the browser disconnect', 'document.body.dataset.disconnected', (v) => v === 'relay');
  for (const record of ['pairing', 'vault-secret', 'vault-blob', 'site-links']) {
    if ((await evaluate(readRecord(record))) !== 'null') throw new Error(`Disconnect kept the record "${record}"`);
  }
  const refused = await upload(phone, 9).then(
    () => 'stored',
    (error: unknown) => String(error),
  );
  if (!refused.includes(': 410')) throw new Error(`After Disconnect the phone's upload was ${refused}, not 410`);
  await open('popup/popup.html');
  await attribute(evaluate, 'the popup to offer pairing again', 'document.body.dataset.paired', (v) => v === 'no');
  if ((await evaluate("String(document.getElementById('notice').hidden)")) !== 'true') {
    throw new Error('The popup said the phone removed the browser, which disconnected itself');
  }
}

/** A JSON message protocol: requests with ids, answers matched to them, and events. */
abstract class Connection {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly events: { method: string; params: any; sessionId?: string }[] = [];

  protected abstract write(text: string): void;

  protected receive(text: string): void {
    const message = JSON.parse(text);
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      // DevTools answers with error/result, BiDi with type: "error"/"success".
      if (message.error) reject(new Error(`${JSON.stringify(message.error)} ${message.message ?? ''}`));
      else resolve(message.result);
    } else if (typeof message.method === 'string') {
      this.events.push({ method: message.method, params: message.params, sessionId: message.sessionId });
    }
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      // A call into a frame that goes away meanwhile may never be answered.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No answer to ${method}`));
      }, TIMEOUT_MS / 2);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
}

/** Chrome's DevTools protocol over --remote-debugging-pipe: messages end with a NUL byte. */
class PipeConnection extends Connection {
  private buffer = '';

  constructor(private readonly output: Writable, input: Readable) {
    super();
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.receive(text);
      }
    });
  }

  protected write(text: string): void {
    this.output.write(`${text}\0`);
  }
}

class SocketConnection extends Connection {
  constructor(private readonly socket: WebSocket) {
    super();
    socket.addEventListener('message', (event) => this.receive(String(event.data)));
  }

  protected write(text: string): void {
    this.socket.send(text);
  }
}

function stop(child: ChildProcess, profile: string): void {
  child.kill('SIGKILL');
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A browser still releasing files; the temporary directory goes eventually.
  }
}

/**
 * A copy of the build with access to sites already granted, as it would be once the person turned
 * filling on: the manifest asks for it outright instead of optionally.
 */
function withSiteAccess(dir: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'cometotp-build-'));
  cpSync(dir, copy, { recursive: true });
  const path = join(copy, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  m.host_permissions = m.optional_host_permissions;
  delete m.optional_host_permissions;
  writeFileSync(path, JSON.stringify(m, null, 2));
  return copy;
}

async function loadInChrome(binary: string, built: string, relay: string, pages: Pages): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'cometotp-chrome-'));
  const dir = withSiteAccess(built);
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ];
  // CI runners do not allow Chrome's sandbox.
  if (process.env.CI) args.push('--no-sandbox');
  const child = spawn(binary, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  try {
    const cdp = new PipeConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: dir });
    const worker = `chrome-extension://${id}/background.js`;
    await waitFor('the background service worker', async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.some((t: any) => t.type === 'service_worker' && t.url === worker) ? true : undefined;
    });

    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${id}/popup/popup.html` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    const answer = await waitFor('the popup to reach the background', async () => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.body?.dataset.background', returnByValue: true }, sessionId);
      return typeof result.value === 'string' ? (result.value as string) : undefined;
    });
    if (answer !== version()) throw new Error(`The background answered "${answer}", not ${version()}`);

    const evaluate: Evaluate = async (expression) => {
      const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
      return typeof reply.result?.value === 'string' ? (reply.result.value as string) : undefined;
    };
    await exerciseLock(evaluate);
    const openChrome = async (path: string) => {
      await cdp.send('Page.navigate', { url: `chrome-extension://${id}/${path}` }, sessionId);
      await delay(500);
    };

    // A virtual authenticator that verifies the person at once, with or without PRF.
    await cdp.send('WebAuthn.enable', { enableUI: false }, sessionId);
    let authenticatorId: string | undefined;
    await exercisePasskey(evaluate, openChrome, async (prf) => {
      if (authenticatorId) await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }, sessionId);
      ({ authenticatorId } = await cdp.send(
        'WebAuthn.addVirtualAuthenticator',
        {
          options: {
            protocol: 'ctap2',
            ctap2Version: 'ctap2_1',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            hasPrf: prf,
            automaticPresenceSimulation: true,
          },
        },
        sessionId,
      ));
    });
    await exerciseSettings(evaluate, openChrome);
    const phone = await exercisePairing(evaluate, openChrome, relay);

    // Pages act as focused, as in a window in front. Frames from elsewhere run as targets of their
    // own: Chrome lists those there are, and each is attached to once.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    const frameSessions = new Map<string, string>();
    const inFrame = async (part: string, expression: string) => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const frame = (targetInfos as { targetId: string; type: string; url: string }[]).find((t) => t.type === 'iframe' && t.url.includes(part));
      if (!frame) return undefined;
      let frameSession = frameSessions.get(frame.targetId);
      if (!frameSession) {
        ({ sessionId: frameSession } = await cdp.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true }));
        frameSessions.set(frame.targetId, frameSession!);
      }
      const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, frameSession);
      if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
      return typeof reply.result?.value === 'string' ? (reply.result.value as string) : undefined;
    };
    await exerciseFill(
      {
        evaluate,
        open: openChrome,
        visit: async (url) => {
          await cdp.send('Page.navigate', { url }, sessionId);
          await delay(500);
        },
        click: async (x, y) => {
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
          }
        },
        inFrame,
        frames: async () => {
          const { targetInfos } = await cdp.send('Target.getTargets');
          return (targetInfos as { type: string; url: string }[]).filter((t) => t.type === 'iframe').map((t) => t.url);
        },
      },
      phone,
      pages,
      false,
    );
    await exerciseSync(evaluate, openChrome, phone);
    await exerciseDisconnect(evaluate, openChrome, await exercisePairing(evaluate, openChrome, relay));
    const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' && e.sessionId === sessionId);
    if (errors.length) throw new Error(`A page threw: ${JSON.stringify(errors[0]!.params.exceptionDetails)}`);
  } finally {
    stop(child, profile);
    rmSync(dir, { recursive: true, force: true });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** What the Firefox popup said about passkeys, for the summary. */
let firefoxPasskeys = '';

async function loadInFirefox(binary: string, built: string, relay: string, pages: Pages): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'cometotp-firefox-'));
  const dir = withSiteAccess(built);
  const prefs = {
    'extensions.webextensions.uuids': JSON.stringify({ [GECKO_ID]: FIREFOX_UUID }),
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
  };
  writeFileSync(
    join(profile, 'user.js'),
    Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`).join(''),
  );
  const port = await freePort();
  const child = spawn(binary, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  let log = '';
  child.stderr!.on('data', (chunk) => (log += String(chunk)));
  try {
    const url = await waitFor('Firefox to listen for WebDriver BiDi', async () => /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(log)?.[1]);
    const socket = new WebSocket(`${url}/session`);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', () => reject(new Error('Could not connect to Firefox')));
    });
    const bidi = new SocketConnection(socket);
    try {
      await bidi.send('session.new', { capabilities: {} });
      const { extension } = await bidi.send('webExtension.install', { extensionData: { type: 'path', path: dir } });
      if (extension !== GECKO_ID) throw new Error(`Firefox installed "${extension}", not ${GECKO_ID}`);

      const { context } = await bidi.send('browsingContext.create', { type: 'tab' });
      await bidi.send('browsingContext.navigate', { context, url: `moz-extension://${FIREFOX_UUID}/popup/popup.html`, wait: 'complete' });
      const answer = await waitFor('the popup to reach the background', async () => {
        const reply = await bidi.send('script.evaluate', {
          expression: 'document.body?.dataset.background',
          target: { context },
          awaitPromise: false,
        });
        return reply.result?.type === 'string' ? (reply.result.value as string) : undefined;
      });
      if (answer !== version()) throw new Error(`The background answered "${answer}", not ${version()}`);

      const evaluate: Evaluate = async (expression) => {
        const reply = await bidi.send('script.evaluate', { expression, target: { context }, awaitPromise: true });
        if (reply.type === 'exception') throw new Error(JSON.stringify(reply.exceptionDetails));
        return reply.result?.type === 'string' ? (reply.result.value as string) : undefined;
      };
      await exerciseLock(evaluate);
      // WebDriver BiDi has no virtual authenticator yet, so here only whether passkeys are offered.
      firefoxPasskeys = await attribute(evaluate, 'the passkey panel', 'document.body.dataset.passkey', () => true);
      const openFirefox = async (path: string) => {
        await bidi.send('browsingContext.navigate', { context, url: `moz-extension://${FIREFOX_UUID}/${path}`, wait: 'complete' });
      };
      await exerciseSettings(evaluate, openFirefox);
      const phone = await exercisePairing(evaluate, openFirefox, relay);
      const tree = async () => {
        const { contexts } = await bidi.send('browsingContext.getTree', { root: context });
        const all: { context: string; url: string; children?: unknown[] }[] = [];
        const walk = (nodes: any[]) => nodes.forEach((node) => (all.push(node), walk(node.children ?? [])));
        walk(contexts);
        return all.filter((node) => node.context !== context);
      };
      const inFrame = async (part: string, expression: string) => {
        const frame = (await tree()).find((node) => node.url.includes(part));
        if (!frame) return undefined;
        const reply = await bidi.send('script.evaluate', { expression, target: { context: frame.context }, awaitPromise: true });
        if (reply.type === 'exception') throw new Error(JSON.stringify(reply.exceptionDetails));
        return reply.result?.type === 'string' ? (reply.result.value as string) : undefined;
      };
      await exerciseFill(
        {
          evaluate,
          open: openFirefox,
          visit: async (url) => {
            await bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
          },
          click: async (x, y) => {
            await bidi.send('input.performActions', {
              context,
              actions: [
                {
                  type: 'pointer',
                  id: 'mouse',
                  parameters: { pointerType: 'mouse' },
                  actions: [
                    { type: 'pointerMove', x, y },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pointerUp', button: 0 },
                  ],
                },
              ],
            });
          },
          inFrame,
          frames: async () => (await tree()).map((node) => node.url),
        },
        phone,
        pages,
        true,
      );
      await exerciseSync(evaluate, openFirefox, phone);
      await exerciseDisconnect(evaluate, openFirefox, await exercisePairing(evaluate, openFirefox, relay));
      await bidi.send('session.end').catch(() => undefined);
    } finally {
      socket.close();
    }
  } finally {
    stop(child, profile);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Starts the relay from this repository on a free port, in memory, with short long polls. */
async function startRelay(): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const relay = spawn(process.execPath, [join(EXTENSION_DIR, '..', 'relay', 'dist', 'src', 'main.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: ':memory:', LONG_POLL_MS: '2000' },
  });
  let log = '';
  relay.stdout!.on('data', (chunk) => (log += String(chunk)));
  await waitFor('the relay to listen', async () => (log.includes('listening') ? true : undefined));
  return { url: `http://127.0.0.1:${port}`, stop: () => relay.kill('SIGKILL') };
}

async function relayCall(relay: string, method: string, path: string, token?: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body instanceof Uint8Array) headers['Content-Type'] = 'application/octet-stream';
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(relay + path, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** What the stand-in phone keeps once paired, to upload again and to remove the browser. */
interface PhoneVault {
  relay: string;
  id: Bytes;
  write: Bytes;
  key: Bytes;
  services: Service[];
}

async function serviceFor(secret: string, type: Service['type'], issuer: string, label: string): Promise<Service> {
  return { id: await serviceId(fromBase32(secret)), type, secret, algorithm: 'SHA1', digits: type === 'steam' ? 5 : 6, period: 30, issuer, label };
}

async function upload(phone: PhoneVault, version: number): Promise<void> {
  const json = buildPayload({ v: 1, phone: 'Load test phone', updated: Math.floor(Date.now() / 1000), services: phone.services });
  await relayCall(phone.relay, 'PUT', `/v1/vault/${toBase64Url(phone.id)}`, toBase64Url(phone.write), await sealVault(phone.key, phone.id, version, json));
}

/**
 * Pairs the extension with a stand-in for CometOTP on a phone, which does the phone's side of
 * protocol §3.4 with the protocol package: the page is pointed at a relay on this computer, the
 * phone reads the code from it (in place of a camera), checks that the page shows its six digits,
 * and once the person confirms, uploads a vault with one service and sends its details. The page
 * must end paired with that service, keeping the vault key out of plain sight.
 */
async function exercisePairing(evaluate: Evaluate, open: (path: string) => Promise<void>, relay: string): Promise<PhoneVault> {
  // The page makes its first code at once: through the local relay by another address, as if the
  // person had chosen it before, so no test run reaches the official relay.
  await evaluate(writeRecord('relay', relay.replace('127.0.0.1', 'localhost')));
  await open('pair/pair.html');
  await attribute(evaluate, 'the first code', 'document.body.dataset.step', (v) => v === 'code');
  await evaluate(click('relay-change'));
  await evaluate(fill('relay-form', { 'relay-input': relay }));
  const uri = await attribute(evaluate, 'a code through the local relay', "document.getElementById('qr').dataset.uri ?? ''", (v) =>
    v.includes(encodeURIComponent(relay)),
  );

  // The phone scans the code and answers with its hello, claiming the channel.
  const code = parsePairingUri(uri, { allowInsecureRelay: true });
  if (code.browserName !== BROWSER_NAME) throw new Error(`The code names the browser "${code.browserName}", not the name chosen`);
  const channel = toBase64Url(code.channel);
  const phone = await generateKeyPair();
  const keys = await derivePairingKeys(await ecdh(phone.privateKey, code.browserPublicKey), code.secret, await pairingTranscript(code, phone.publicKey));
  const hello = await sealPairingFrame(keys, code.channel, TO_BROWSER, 1, { t: 'hello', phone: 'Load test phone' }, phone.publicKey);
  const { token } = await relayCall(relay, 'POST', `/v1/pair/${channel}/to-browser`, undefined, { m: toBase64Url(hello) });

  const sas = await attribute(evaluate, 'the six digits', "document.body.dataset.step === 'compare' ? document.getElementById('sas').textContent : ''", (v) => v !== '');
  if (sas !== keys.sas) throw new Error(`The page shows ${sas}, the phone ${keys.sas}`);
  await evaluate(click('confirm'));

  const fromBrowser = async (index: number): Promise<PairingMessage> => {
    const frame = await waitFor(`the browser's message ${index}`, async () => {
      const { messages } = await relayCall(relay, 'GET', `/v1/pair/${channel}/to-phone?after=${index - 1}`, token);
      return messages[0] ? fromBase64Url(messages[0].m as string) : undefined;
    });
    return openPairingFrame(keys, code.channel, TO_PHONE, index, frame);
  };
  if ((await fromBrowser(1)).t !== 'confirm') throw new Error('The browser did not confirm');

  // Both have confirmed: the phone makes the vault, uploads version 1 and sends its details.
  const id = randomBytes(16);
  const write = randomBytes(32);
  const read = randomBytes(32);
  const key = randomBytes(32);
  const sha = (bytes: Bytes) => toBase64Url(createHash('sha256').update(bytes).digest());
  await relayCall(relay, 'POST', '/v1/vaults', undefined, { id: toBase64Url(id), write: sha(write), read: sha(read) });
  const phoneVault: PhoneVault = { relay, id, write, key, services: [await serviceFor('JBSWY3DPEHPK3PXP', 'totp', 'GitHub', 'alice')] };
  await upload(phoneVault, 1);
  const vault = { t: 'vault' as const, id: toBase64Url(id), read: toBase64Url(read), key: toBase64Url(key) };
  await relayCall(relay, 'POST', `/v1/pair/${channel}/to-browser`, token, { m: toBase64Url(await sealPairingFrame(keys, code.channel, TO_BROWSER, 2, vault)) });
  if ((await fromBrowser(2)).t !== 'done') throw new Error('The browser did not say done');
  // The page has already ended the channel; the phone deletes it too, whatever the relay says.
  await relayCall(relay, 'DELETE', `/v1/pair/${channel}`, token).catch(() => undefined);

  await attribute(evaluate, 'the page to say paired', 'document.body.dataset.step', (v) => v === 'done');
  const message = await evaluate("document.getElementById('done-message').textContent");
  if (!message?.includes('1 service')) throw new Error(`The page says "${message}"`);

  // What was kept: the details to download with, the version accepted, and V only sealed.
  const record = JSON.parse((await evaluate(readRecord('pairing'))) ?? 'null');
  if (record?.vault !== vault.id || record.read !== vault.read || record.relay !== relay || record.version !== 1) {
    throw new Error(`Unexpected pairing record ${JSON.stringify(record)}`);
  }
  const sealed = (await evaluate(readRecord('vault-secret'))) ?? '';
  if (!sealed.includes('nonce') || sealed.includes(vault.key)) throw new Error('The vault key is not sealed');

  return phoneVault;
}

/** The codes the popup shows, without the spaces it groups them with. */
const READ_CODES = "JSON.stringify([...document.querySelectorAll('#services .code')].map((c) => c.textContent.replace(/ /g, '')))";

/** Whether the popup's codes are the protocol package's for these services, now or just before. */
async function sameCodes(shown: string[], services: Service[]): Promise<boolean> {
  const now = Date.now() / 1000;
  // The popup recomputes codes once a second, so at the turn of a period it may show the last
  // period's codes for a second, and reading them takes a moment more.
  for (const time of [now, now - 1, now - 2]) {
    const expected = await Promise.all(services.map((service) => generateCode(service, time)));
    if (JSON.stringify(expected) === JSON.stringify(shown)) return true;
  }
  return false;
}

/**
 * After pairing: the popup shows the service with the code the protocol package computes. The
 * phone then adds a service and uploads version 2, which the popup shows when it next opens. Last,
 * the phone removes the browser (deletes the vault): the popup says so and the copy is gone.
 */
async function exerciseSync(evaluate: Evaluate, open: (path: string) => Promise<void>, phone: PhoneVault): Promise<void> {
  await open('popup/popup.html');
  await attribute(evaluate, 'the popup to show the codes', "document.getElementById('updated')?.textContent ?? ''", (v) =>
    v.includes('from Load test phone'),
  );
  const first = JSON.parse((await evaluate(READ_CODES)) ?? '[]') as string[];
  if (!(await sameCodes(first, phone.services))) throw new Error(`The popup shows ${JSON.stringify(first)}, not the services' codes`);

  phone.services.push(await serviceFor('GEZDGNBVGY3TQOJQ', 'steam', 'Steam', 'gamer'));
  await upload(phone, 2);
  await open('popup/popup.html');
  await attribute(evaluate, 'the change on the phone', 'document.body.dataset.codes', (v) => v === '2');
  const second = JSON.parse((await evaluate(READ_CODES)) ?? '[]') as string[];
  if (!(await sameCodes(second, phone.services))) throw new Error(`After the change the popup shows ${JSON.stringify(second)}`);

  await relayCall(phone.relay, 'DELETE', `/v1/vault/${toBase64Url(phone.id)}`, toBase64Url(phone.write));
  await open('popup/popup.html');
  await attribute(evaluate, 'the popup to say the phone removed it', "document.getElementById('notice')?.textContent ?? ''", (v) =>
    v.includes('removed this browser'),
  );
  if ((await evaluate(readRecord('pairing'))) !== 'null') throw new Error('The pairing was kept after the phone removed the browser');
  if ((await evaluate(readRecord('vault-blob'))) !== 'null') throw new Error('The copy was kept after the phone removed the browser');
  if ((await evaluate("String(document.querySelectorAll('#services li').length)")) !== '0') throw new Error('The popup kept the rows');
}

/** Pages to fill codes into, served on 127.0.0.1, with a frame from localhost: another host. */
interface Pages {
  origin: string;
  stop: () => void;
}

/**
 * A sign-in page's content security policy, strict as many are: nothing from extensions is
 * allowed. The page's one script records the events it sees, to say what happened if a step fails.
 */
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self' http://localhost:*";

const EVENTS_SCRIPT = `window.seen = [];
for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'focusin', 'focusout', 'keydown']) {
  document.addEventListener(type, (e) => {
    const t = e.target;
    window.seen.push(Math.round(performance.now()) + ' ' + type + (e.isTrusted ? '' : ' (untrusted)') + ' ' + (t.id || t.localName || '?'));
  }, true);
}`;

async function startPages(): Promise<Pages> {
  const port = await freePort();
  const frame = `<!doctype html><meta charset="utf-8"><title>Frame</title>
<label for="frame-otp">Authentication code</label> <input id="frame-otp" autocomplete="one-time-code" maxlength="6">`;
  const page = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<script src="/events.js"></script>
<form style="font-size: 16px">
  <p><label for="email">Email</label> <input id="email" type="email" name="email" autocomplete="username"></p>
  <p><label for="otp">Authentication code</label>
    <input id="otp" name="app_otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" style="width: 240px; padding: 6px"></p>
  <div id="boxes">${'<input maxlength="1" inputmode="numeric" style="width: 24px; margin: 2px">'.repeat(6)}</div>
</form>
<iframe id="same" src="/frame.html" style="width: 400px; height: 60px"></iframe>
<iframe id="other" src="http://localhost:${port}/frame.html" style="width: 400px; height: 60px"></iframe>`;
  const server = createHttpServer((request, response) => {
    if (request.url === '/events.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(EVENTS_SCRIPT);
      return;
    }
    const body = request.url === '/fill.html' ? page : request.url === '/frame.html' ? frame : null;
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

/** How exerciseFill drives a browser's tab. */
interface FillDriver {
  /** Runs an expression in the tab's page. */
  evaluate: Evaluate;
  /** Opens an extension page in the tab. */
  open(path: string): Promise<void>;
  /** Opens a web page in the tab. */
  visit(url: string): Promise<void>;
  /** A person's click at a point of the tab, in CSS pixels. */
  click(x: number, y: number): Promise<void>;
  /** Runs an expression in a frame of the tab whose address contains `part`; undefined without one. */
  inFrame(part: string, expression: string): Promise<string | undefined>;
  /** The addresses of the tab's frames, to say what was there when something fails. */
  frames(): Promise<string[]>;
}

/** Whether the page holds the CometOTP button: its host element, as the rest is in a closed shadow root. */
const HAS_BUTTON = "document.querySelector('cometotp-fill') ? 'yes' : 'no'";

/** The centre of an element's box, from an expression for the element. */
async function centre(evaluate: Evaluate, element: string): Promise<{ x: number; y: number; right: number }> {
  const rect = JSON.parse(
    (await evaluate(`(() => { const e = ${element}; e.scrollIntoView({ block: 'center' }); return JSON.stringify(e.getBoundingClientRect()); })()`))!,
  ) as { left: number; top: number; width: number; height: number; right: number };
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), right: rect.right };
}

/** Whether `shown` is the service's code at some moment from `since` (milliseconds) to now. */
async function codeSince(shown: string | undefined, service: Service, since: number): Promise<boolean> {
  for (let time = Math.floor(since / 1000) - 1; time <= Date.now() / 1000 + service.period; time += service.period) {
    if (time <= Date.now() / 1000 && shown === (await generateCode(service, time))) return true;
  }
  return shown === (await generateCode(service, Date.now() / 1000));
}

/**
 * Filling codes into a page this test serves, under a strict content security policy. The popup
 * says filling is on (the build has access to sites already). Focusing the page's code field shows the
 * CometOTP button, and the email field does not. The button opens the menu: on 127.0.0.1 nothing is
 * offered at first, a search finds the service, and choosing it, then confirming the site as its
 * first, fills the field with its code and links it to the site. Then six one-digit boxes get one digit each, from the service now offered
 * first; a field in a frame from the same host gets the button, and one from another host does
 * not; Escape closes the menu. Last, where the browser lets the extension give access back
 * (Firefox: Chrome keeps access the manifest asks for), Turn off removes the button.
 */
async function exerciseFill(driver: FillDriver, phone: PhoneVault, pages: Pages, canTurnOff: boolean): Promise<void> {
  const { evaluate } = driver;
  const service = phone.services[0]!;
  await driver.open('settings/settings.html');
  await attribute(evaluate, 'the settings page to say filling is on', 'document.body.dataset.filling', (v) => v === 'on');

  const button = async (field: string) => {
    await evaluate(`(${field}.focus(), 'focused')`);
    await attribute(evaluate, `the button in ${field}`, HAS_BUTTON, (v) => v === 'yes');
  };
  const menu = (expression: string) => driver.inFrame('fill/menu.html', expression);
  /** Waits for the menu, saying what it shows instead if it never gets there. */
  const inMenu = async (what: string, expression: string, expected: (value: string | undefined) => boolean) => {
    try {
      await waitFor(what, async () => (expected(await menu(expression)) ? true : undefined));
    } catch (error) {
      const shows = await menu("document.getElementById('menu')?.innerText ?? ''").catch(() => undefined);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; the menu shows ${JSON.stringify(shows)}`);
    }
  };
  const openMenu = async (field: string, outside: boolean) => {
    const box = await centre(evaluate, field);
    // The button sits at the end of a wide field, and just after a narrow one.
    await driver.click(Math.round(outside ? box.right + 4 + 12 : box.right - 6 - 12), box.y);
    await inMenu('the menu', "document.getElementById('site').textContent", (v) => v === '127.0.0.1');
  };
  /** The open menu's one-time name, to tell it from a menu opened after it if one stays. */
  let chosenFrom: string | undefined;
  const menuGone = async () => {
    try {
      await waitFor('the menu to close', async () => ((await menu('location.href')) === undefined ? true : undefined));
    } catch (error) {
      const shows = await menu("document.getElementById('menu')?.innerText ?? ''").catch(() => undefined);
      const fields = await evaluate("JSON.stringify([...document.querySelectorAll('input')].map((i) => i.value))").catch(() => undefined);
      const hosts = await evaluate("String(document.querySelectorAll('cometotp-fill').length)").catch(() => undefined);
      const frames = await driver.frames().catch(() => []);
      const seen = await evaluate('JSON.stringify((window.seen ?? []).slice(-40))').catch(() => undefined);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; the menu shows ${JSON.stringify(shows)}; ` +
          `the fields hold ${fields}; ${hosts} button host(s); frames ${JSON.stringify(frames)}; chosen from menu ${chosenFrom}; ` +
          `the page saw ${seen}`,
      );
    }
  };

  await driver.visit(`${pages.origin}/fill.html`);
  await button("document.getElementById('otp')");
  await evaluate("(document.getElementById('email').focus(), 'focused')");
  await attribute(evaluate, 'no button in the email field', HAS_BUTTON, (v) => v === 'no');

  // Nothing is linked to this site yet, and "GitHub" does not name it: a search finds the service.
  await button("document.getElementById('otp')");
  await openMenu("document.getElementById('otp')", false);
  await inMenu('the menu to offer nothing', "String(document.getElementById('none').hidden)", (v) => v === 'false');
  await menu(`(() => { const s = document.getElementById('search'); s.value = 'git'; s.dispatchEvent(new Event('input')); return 'searched'; })()`);
  await inMenu('the search to find the service', "String(document.querySelectorAll('#found .service').length)", (v) => v === '1');
  let chosen = Date.now();
  chosenFrom = await menu('location.hash');
  await menu("(document.querySelector('#found .service').click(), 'chosen')");
  // Its first fill on a site asks the person to check the address.
  await inMenu('the menu to ask about the site', "String(document.getElementById('confirm').hidden)", (v) => v === 'false');
  await menu("(document.getElementById('confirm-fill').click(), 'confirmed')");
  await menuGone();
  const filled = await evaluate("document.getElementById('otp').value");
  if (!(await codeSince(filled, service, chosen))) throw new Error(`The field holds "${filled}", not the service's code`);
  if ((await evaluate("document.getElementById('email').value")) !== '') throw new Error('A code went into another field');

  // The boxes: the service is now linked to this site, so it is offered first.
  await button("document.querySelector('#boxes input')");
  await openMenu("document.querySelector('#boxes input:last-child')", true);
  await inMenu('the menu to offer the linked service', "document.querySelector('#offered .issuer')?.textContent", (v) => v === 'GitHub');
  chosen = Date.now();
  chosenFrom = await menu('location.hash');
  await menu("(document.querySelector('#offered .service').click(), 'chosen')");
  await menuGone();
  const digits = await evaluate("[...document.querySelectorAll('#boxes input')].map((i) => i.value).join('')");
  if (!(await codeSince(digits, service, chosen))) throw new Error(`The boxes hold "${digits}", not the service's code`);

  // Escape closes the menu.
  await button("document.getElementById('otp')");
  await openMenu("document.getElementById('otp')", false);
  await menu("(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), 'pressed')");
  await menuGone();

  // A frame from this host gets the button; one from another host does not.
  const same = "document.getElementById('same').contentDocument";
  await evaluate(`(${same}.getElementById('frame-otp').focus(), 'focused')`);
  await attribute(evaluate, 'the button in a frame from this host', `${same}.querySelector('cometotp-fill') ? 'yes' : 'no'`, (v) => v === 'yes');
  await waitFor('the frame from another host', () => driver.inFrame('localhost', "(document.getElementById('frame-otp').focus(), 'focused')"));
  await delay(1500);
  if ((await driver.inFrame('localhost', HAS_BUTTON)) !== 'no') throw new Error('A frame from another host got the button');

  await driver.open('settings/settings.html');
  if ((await evaluate(readRecord('site-links'))) === 'null') throw new Error('The service was not linked to the site');
  if (canTurnOff) {
    await evaluate(click('filling-off'));
    await attribute(evaluate, 'access to sites to be removed', 'document.body.dataset.filling', (v) => v === 'off');
    await driver.visit(`${pages.origin}/fill.html`);
    await evaluate("(document.getElementById('otp').focus(), 'focused')");
    await delay(1500);
    if ((await evaluate(HAS_BUTTON)) !== 'no') throw new Error('The button stayed after filling was turned off');
  }
}

const browsers: {
  name: string;
  target: Target;
  binary: string | undefined;
  load: (binary: string, dir: string, relay: string, pages: Pages) => Promise<void>;
}[] = [
  {
    name: 'Chrome',
    target: 'chromium',
    binary: find(argument('--chrome'), process.env.CHROME_PATH, [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]),
    load: loadInChrome,
  },
  {
    name: 'Firefox',
    target: 'firefox',
    binary: find(argument('--firefox'), process.env.FIREFOX_PATH, [
      '/usr/bin/firefox',
      '/Applications/Firefox.app/Contents/MacOS/firefox',
    ]),
    load: loadInFirefox,
  },
];

let failed = false;
const relay = await startRelay();
const pages = await startPages();
for (const browser of browsers) {
  if (!browser.binary) {
    console.log(`${browser.name}: not found${process.argv.includes('--require-all') ? '' : ', skipped'}`);
    if (process.argv.includes('--require-all')) failed = true;
    continue;
  }
  try {
    await browser.load(browser.binary, targetDir(browser.target), relay.url, pages);
    const passkeys =
      browser.target === 'chromium'
        ? 'a passkey unlocks it'
        : `passkeys ${firefoxPasskeys === 'unsupported' ? 'are not offered (no PRF)' : 'are offered'}`;
    console.log(
      `${browser.name}: the ${browser.target} build loads, its popup reaches the background (${version()}), the lock works, ${passkeys}, its settings work, it pairs with a phone, fills codes into a page, its codes follow the phone's, and it disconnects`,
    );
  } catch (error) {
    failed = true;
    console.error(`${browser.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
relay.stop();
pages.stop();
process.exitCode = failed ? 1 : 0;
