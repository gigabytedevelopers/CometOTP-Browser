// Loads each build into a real browser, in a throwaway profile, and checks that it works there:
// the browser accepts it, its popup page opens, and the page reaches the background, which answers
// with the extension's version (src/popup/popup.ts records it in `data-background`). Then it uses
// the lock as a person would, through the popup (see exerciseLock), and in Chrome adds a passkey
// on a virtual authenticator with the PRF extension and unlocks with it (see exercisePasskey).
// Last, it pairs with a stand-in phone through a relay it starts on this computer (see
// exercisePairing).
//
// - Chrome, driven through the DevTools protocol over a pipe: Extensions.loadUnpacked, which
//   needs --enable-unsafe-extension-debugging.
// - Firefox, driven through WebDriver BiDi: webExtension.install, a temporary install as from
//   about:debugging. A preference fixes the extension's moz-extension:// address beforehand, and
//   MOZ_REMOTE_ALLOW_SYSTEM_ACCESS lets the test open that address, which WebDriver otherwise
//   refuses as privileged (the --remote-allow-system-access flag it replaces is gone in 159).
//
// Usage: node dist/tools/load-test.js [--chrome <path>] [--firefox <path>] [--require-all]
// Without a path, the usual install locations are tried, and a browser that is not found is
// skipped, unless --require-all is given (as in CI).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import {
  TO_BROWSER,
  TO_PHONE,
  buildPayload,
  derivePairingKeys,
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
} from '@cometotp/protocol';

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
async function exercisePasskey(evaluate: Evaluate, useAuthenticator: (prf: boolean) => Promise<void>): Promise<void> {
  const support = await attribute(evaluate, 'the passkey panel', 'document.body.dataset.passkey', () => true);
  if (support !== 'none') throw new Error(`Passkeys should be offered here, but the popup says "${support}"`);
  await useAuthenticator(true);
  await evaluate(click('passkey-add'));
  await attribute(evaluate, 'the passkey to be added', 'document.body.dataset.passkey', (v) => v === 'added');
  const key = await evaluate(READ_SESSION_KEY);

  await evaluate(click('lock'));
  await view(evaluate, 'locked');
  // The popup offers the passkey once it has read the lock record, a moment after it shows.
  await attribute(evaluate, 'the locked popup to offer the passkey', "String(document.getElementById('passkey-unlock').hidden)", (v) => v === 'false');
  await evaluate(click('passkey-unlock-submit'));
  await view(evaluate, 'unlocked');
  if ((await evaluate(READ_SESSION_KEY)) !== key) throw new Error('The passkey unlocked to a different local key');

  await useAuthenticator(false);
  await evaluate(click('passkey-add'));
  await attribute(evaluate, 'a passkey without PRF to be refused', "document.getElementById('passkey-error').textContent", (v) =>
    v.includes('cannot unlock'),
  );
  if ((await evaluate('document.body.dataset.passkey')) !== 'added') throw new Error('A refused passkey replaced the one added');

  await evaluate(click('lock'));
  await view(evaluate, 'locked');
  await evaluate(fill('unlock-form', { 'unlock-password': PASSWORD }));
  await view(evaluate, 'unlocked');
  if ((await evaluate(READ_SESSION_KEY)) !== key) throw new Error('The password unlocked to a different local key');
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
      this.pending.set(id, { resolve, reject });
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

async function loadInChrome(binary: string, dir: string, relay: string): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'cometotp-chrome-'));
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

    // A virtual authenticator that verifies the person at once, with or without PRF.
    await cdp.send('WebAuthn.enable', { enableUI: false }, sessionId);
    let authenticatorId: string | undefined;
    await exercisePasskey(evaluate, async (prf) => {
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
    await exercisePairing(
      evaluate,
      async (path) => {
        await cdp.send('Page.navigate', { url: `chrome-extension://${id}/${path}` }, sessionId);
        await delay(500);
      },
      relay,
    );
    const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' && e.sessionId === sessionId);
    if (errors.length) throw new Error(`A page threw: ${JSON.stringify(errors[0]!.params.exceptionDetails)}`);
  } finally {
    stop(child, profile);
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

async function loadInFirefox(binary: string, dir: string, relay: string): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'cometotp-firefox-'));
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
      await exercisePairing(
        evaluate,
        async (path) => {
          await bidi.send('browsingContext.navigate', { context, url: `moz-extension://${FIREFOX_UUID}/${path}`, wait: 'complete' });
        },
        relay,
      );
      await bidi.send('session.end').catch(() => undefined);
    } finally {
      socket.close();
    }
  } finally {
    stop(child, profile);
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

/**
 * Pairs the extension with a stand-in for CometOTP on a phone, which does the phone's side of
 * protocol §3.4 with the protocol package: the page is pointed at a relay on this computer, the
 * phone reads the code from it (in place of a camera), checks that the page shows its six digits,
 * and once the person confirms, uploads a vault with one service and sends its details. The page
 * must end paired with that service, keeping the vault key out of plain sight.
 */
async function exercisePairing(evaluate: Evaluate, open: (path: string) => Promise<void>, relay: string): Promise<void> {
  await open('pair/pair.html');
  await attribute(evaluate, 'the first code', 'document.body.dataset.step', (v) => v === 'code');
  await evaluate(click('relay-change'));
  await evaluate(fill('relay-form', { 'relay-input': relay }));
  const uri = await attribute(evaluate, 'a code through the local relay', "document.getElementById('qr').dataset.uri ?? ''", (v) =>
    v.includes(encodeURIComponent(relay)),
  );

  // The phone scans the code and answers with its hello, claiming the channel.
  const code = parsePairingUri(uri, { allowInsecureRelay: true });
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
  const secret = 'JBSWY3DPEHPK3PXP';
  const json = buildPayload({
    v: 1,
    phone: 'Load test phone',
    updated: Math.floor(Date.now() / 1000),
    services: [{ id: await serviceId(fromBase32(secret)), type: 'totp', secret, algorithm: 'SHA1', digits: 6, period: 30, issuer: 'GitHub', label: 'alice' }],
  });
  await relayCall(relay, 'PUT', `/v1/vault/${toBase64Url(id)}`, toBase64Url(write), await sealVault(key, id, 1, json));
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

  await open('popup/popup.html');
  await attribute(evaluate, 'the popup to name the phone', "document.getElementById('pairing-status')?.textContent ?? ''", (v) =>
    v.includes('Paired with Load test phone'),
  );
}

const browsers: {
  name: string;
  target: Target;
  binary: string | undefined;
  load: (binary: string, dir: string, relay: string) => Promise<void>;
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
for (const browser of browsers) {
  if (!browser.binary) {
    console.log(`${browser.name}: not found${process.argv.includes('--require-all') ? '' : ', skipped'}`);
    if (process.argv.includes('--require-all')) failed = true;
    continue;
  }
  try {
    await browser.load(browser.binary, targetDir(browser.target), relay.url);
    const passkeys =
      browser.target === 'chromium'
        ? 'a passkey unlocks it'
        : `passkeys ${firefoxPasskeys === 'unsupported' ? 'are not offered (no PRF)' : 'are offered'}`;
    console.log(
      `${browser.name}: the ${browser.target} build loads, its popup reaches the background (${version()}), the lock works, ${passkeys}, and it pairs with a phone`,
    );
  } catch (error) {
    failed = true;
    console.error(`${browser.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
relay.stop();
process.exitCode = failed ? 1 : 0;
