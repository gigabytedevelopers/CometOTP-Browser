// The parts of the extension APIs the extension uses, declared here rather than taken from a
// types package: the list stays short and shows at a glance what the extension touches.
// Chromium and Firefox both offer them as `chrome.*`, returning promises in Manifest V3.

declare namespace chrome.runtime {
  interface Manifest {
    version: string;
  }

  interface MessageSender {
    id?: string;
    url?: string;
  }

  function getManifest(): Manifest;

  /** The full URL of a file in the extension. */
  function getURL(path: string): string;

  /** Sends a message to the extension's other pages and its background; resolves with the reply. */
  function sendMessage(message: unknown): Promise<unknown>;

  /** When the browser starts with the extension installed. */
  const onStartup: {
    addListener(callback: () => void): void;
  };

  const onMessage: {
    /** Call `sendResponse` before returning to reply to the sender. */
    addListener(
      callback: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => void,
    ): void;
  };
}

declare namespace chrome.storage {
  interface StorageArea {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
  }

  /** In memory only: cleared when the browser quits, and closed to content scripts. */
  const session: StorageArea;
}

declare namespace chrome.idle {
  /** Firefox reports only "active" and "idle". */
  type IdleState = 'active' | 'idle' | 'locked';

  /** How long without input, in seconds, before the state turns "idle" (at least 15). */
  function setDetectionInterval(seconds: number): void;

  const onStateChanged: {
    addListener(callback: (state: IdleState) => void): void;
  };
}

declare namespace chrome.tabs {
  /** Opens a tab; no permission is needed for this. */
  function create(properties: { url: string }): Promise<unknown>;
}

declare namespace chrome.alarms {
  interface Alarm {
    name: string;
  }

  function get(name: string): Promise<Alarm | undefined>;

  function create(name: string, info: { periodInMinutes: number; delayInMinutes?: number }): Promise<void> | void;

  const onAlarm: {
    addListener(callback: (alarm: Alarm) => void): void;
  };
}
