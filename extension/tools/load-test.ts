// Loads each build into a real browser, in a throwaway profile, and checks that it works there:
// the browser accepts it, its popup page opens, and the page reaches the background, which answers
// with the extension's version (src/popup/popup.ts records it in `data-background`).
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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { GECKO_ID, type Target } from './manifest.js';
import { targetDir, version } from './package.js';

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
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(250);
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

async function loadInChrome(binary: string, dir: string): Promise<void> {
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
    const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' && e.sessionId === sessionId);
    if (errors.length) throw new Error(`The popup threw: ${JSON.stringify(errors[0]!.params.exceptionDetails)}`);
    if (answer !== version()) throw new Error(`The background answered "${answer}", not ${version()}`);
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

async function loadInFirefox(binary: string, dir: string): Promise<void> {
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
      await bidi.send('session.end').catch(() => undefined);
    } finally {
      socket.close();
    }
  } finally {
    stop(child, profile);
  }
}

const browsers: { name: string; target: Target; binary: string | undefined; load: (binary: string, dir: string) => Promise<void> }[] = [
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
for (const browser of browsers) {
  if (!browser.binary) {
    console.log(`${browser.name}: not found${process.argv.includes('--require-all') ? '' : ', skipped'}`);
    if (process.argv.includes('--require-all')) failed = true;
    continue;
  }
  try {
    await browser.load(browser.binary, targetDir(browser.target));
    console.log(`${browser.name}: the ${browser.target} build loads, and its popup reaches the background (${version()})`);
  } catch (error) {
    failed = true;
    console.error(`${browser.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exitCode = failed ? 1 : 0;
