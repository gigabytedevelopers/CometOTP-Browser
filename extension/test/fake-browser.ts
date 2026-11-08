// Stand-ins for the browser storage the extension uses, kept in memory, so the code over it runs
// in Node: IndexedDB as src/lock/storage.ts uses it, and chrome.storage.session.
//
// Like a browser's, this IndexedDB answers each request in a later task, runs transactions one at
// a time in the order they were made, and takes requests only while the task that made the
// transaction runs, or a request's success handler and the promise jobs it queues: a transaction
// left waiting on anything else, Argon2 say, is over, and a request then throws. Values are
// copied in and out, as structured clones.

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

type Records = Map<string, unknown>;
type Handler = ((event: { target: FakeRequest }) => void) | null;

class FakeRequest {
  result: unknown;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
}

class FakeTransaction {
  private open = true;
  private aborted = false;
  private readonly requests: { request: FakeRequest; operation: (records: Records) => unknown }[] = [];
  error: DOMException | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor(
    private readonly records: Records,
    readonly mode: IDBTransactionMode,
  ) {
    setImmediate(() => (this.open = false));
  }

  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this);
  }

  place(operation: (records: Records) => unknown, writes: boolean): FakeRequest {
    if (!this.open) throw new DOMException('The transaction has finished.', 'TransactionInactiveError');
    if (writes && this.mode !== 'readwrite') throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    const request = new FakeRequest();
    this.requests.push({ request, operation });
    return request;
  }

  abort(): void {
    this.aborted = true;
    this.open = false;
  }

  async run(): Promise<void> {
    const before = new Map(this.records);
    await turn();
    for (let next = this.requests.shift(); next && !this.aborted; next = this.requests.shift()) {
      this.open = true;
      next.request.result = next.operation(this.records);
      try {
        next.request.onsuccess?.({ target: next.request });
      } catch {
        // A handler that throws aborts the transaction, as in a browser.
        this.abort();
      }
      // The handler's promise jobs run before this, while the transaction still takes requests.
      await turn();
      this.open = false;
    }
    if (this.aborted) {
      this.records.clear();
      for (const [key, value] of before) this.records.set(key, value);
      this.error = new DOMException('The transaction was aborted.', 'AbortError');
      this.onabort?.();
    } else {
      this.oncomplete?.();
    }
  }
}

class FakeObjectStore {
  constructor(private readonly tx: FakeTransaction) {}

  get(key: string): FakeRequest {
    return this.tx.place((records) => structuredClone(records.get(key)), false);
  }

  put(value: unknown, key: string): FakeRequest {
    const copy = structuredClone(value);
    return this.tx.place((records) => void records.set(key, copy), true);
  }

  delete(key: string): FakeRequest {
    return this.tx.place((records) => void records.delete(key), true);
  }

  clear(): FakeRequest {
    return this.tx.place((records) => records.clear(), true);
  }
}

class FakeDatabase {
  constructor(
    private readonly factory: FakeIndexedDB,
    private readonly stores: Map<string, Records>,
  ) {}

  createObjectStore(name: string): void {
    this.stores.set(name, new Map());
  }

  transaction(name: string, mode: IDBTransactionMode = 'readonly'): FakeTransaction {
    const records = this.stores.get(name);
    if (!records) throw new DOMException(`There is no object store "${name}".`, 'NotFoundError');
    const tx = new FakeTransaction(records, mode);
    this.factory.start(tx);
    return tx;
  }

  close(): void {}
}

export class FakeIndexedDB {
  private readonly databases = new Map<string, { version: number; stores: Map<string, Records> }>();
  private queue: Promise<void> = Promise.resolve();
  private held: { reached: () => void; released: Promise<void> } | null = null;

  open(name: string, version = 1): FakeRequest {
    const request = new FakeRequest();
    void turn().then(() => {
      const existing = this.databases.get(name);
      const database = existing ?? { version, stores: new Map<string, Records>() };
      this.databases.set(name, database);
      request.result = new FakeDatabase(this, database.stores);
      if (!existing || existing.version < version) {
        database.version = version;
        request.onupgradeneeded?.({ target: request });
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  /** Runs `tx` once those made before it are over, or once released if it is held. */
  start(tx: FakeTransaction): void {
    const held = tx.mode === 'readwrite' ? this.held : null;
    if (!held) {
      this.queue = this.queue.then(() => tx.run());
      return;
    }
    this.held = null;
    held.reached();
    void held.released.then(() => {
      this.queue = this.queue.then(() => tx.run());
    });
  }

  /**
   * Holds back the next read-write transaction while later ones go ahead, as if what made it had
   * taken longer: its requests are made, but it runs once released. `reached` resolves once it is
   * made.
   */
  holdNextWrite(): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    this.held = { reached, released: new Promise<void>((resolve) => (release = resolve)) };
    return { reached: reachedPromise, release };
  }
}

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;

/** chrome.storage.session, with its onChanged event. */
export class FakeStorageArea {
  private readonly items = new Map<string, unknown>();
  private readonly listeners: ((changes: Changes) => void)[] = [];
  readonly onChanged = { addListener: (listener: (changes: Changes) => void) => void this.listeners.push(listener) };

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const found: Record<string, unknown> = {};
    for (const key of [keys].flat()) if (this.items.has(key)) found[key] = structuredClone(this.items.get(key));
    return found;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Changes = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: this.items.get(key), newValue: value };
      this.items.set(key, structuredClone(value));
    }
    this.changed(changes);
  }

  async remove(keys: string | string[]): Promise<void> {
    const changes: Changes = {};
    for (const key of [keys].flat()) {
      if (!this.items.has(key)) continue;
      changes[key] = { oldValue: this.items.get(key) };
      this.items.delete(key);
    }
    if (Object.keys(changes).length) this.changed(changes);
  }

  private changed(changes: Changes): void {
    for (const listener of this.listeners) setImmediate(() => listener(changes));
  }
}

/** Puts a new, empty IndexedDB and storage.session where the extension's code looks for them. */
export function installBrowser(): { indexedDB: FakeIndexedDB; session: FakeStorageArea } {
  const indexedDB = new FakeIndexedDB();
  const session = new FakeStorageArea();
  Object.assign(globalThis, { indexedDB, chrome: { storage: { session } } });
  return { indexedDB, session };
}
