// The parts of the extension APIs the extension uses, declared here rather than taken from a
// types package: the list stays short and shows at a glance what the extension touches.
// Chromium and Firefox both offer them as `chrome.*`, returning promises in Manifest V3.

declare namespace chrome.runtime {
  interface Manifest {
    version: string;
  }

  /** Who sent a message, as the browser saw it. */
  interface MessageSender {
    id?: string;
    /** The sending frame's address. */
    url?: string;
    /** The tab, for a content script or a page in a tab or a frame of one. */
    tab?: chrome.tabs.Tab;
    frameId?: number;
  }

  /** The extension's id. */
  const id: string;

  function getManifest(): Manifest;

  /** The full URL of a file in the extension. */
  function getURL(path: string): string;

  /** Sends a message to the extension's other pages and its background; resolves with the reply. */
  function sendMessage(message: unknown): Promise<unknown>;

  /** When the browser starts with the extension installed. */
  const onStartup: {
    addListener(callback: () => void): void;
  };

  /** When the extension is installed or updated. */
  const onInstalled: {
    addListener(callback: () => void): void;
  };

  const onMessage: {
    /**
     * Call `sendResponse` before returning to reply to the sender, or return true and call it
     * later.
     */
    addListener(
      callback: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined | void,
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
  interface Tab {
    id?: number;
    /** Only for sites the extension has access to. */
    url?: string;
  }

  /** Opens a tab; no permission is needed for this. */
  function create(properties: { url: string }): Promise<unknown>;

  /** The tabs showing these addresses, among the sites the extension has access to. */
  function query(filter: { url: string[] }): Promise<Tab[]>;

  /** Sends a message to the extension's content script in one frame of a tab. */
  function sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
}

declare namespace chrome.permissions {
  interface Permissions {
    origins?: string[];
  }

  function contains(permissions: Permissions): Promise<boolean>;

  /** Asks the person; only from a click or another user action. */
  function request(permissions: Permissions): Promise<boolean>;

  function remove(permissions: Permissions): Promise<boolean>;

  const onAdded: {
    addListener(callback: (permissions: Permissions) => void): void;
  };

  const onRemoved: {
    addListener(callback: (permissions: Permissions) => void): void;
  };
}

declare namespace chrome.scripting {
  interface ContentScript {
    id: string;
    js: string[];
    matches: string[];
    allFrames: boolean;
    runAt: 'document_start' | 'document_end' | 'document_idle';
    persistAcrossSessions: boolean;
  }

  function registerContentScripts(scripts: ContentScript[]): Promise<void>;

  function unregisterContentScripts(filter: { ids: string[] }): Promise<void>;

  function getRegisteredContentScripts(filter: { ids: string[] }): Promise<{ id: string }[]>;

  /** Runs files in a tab's frames, as content scripts. */
  function executeScript(injection: { target: { tabId: number; allFrames: boolean }; files: string[] }): Promise<unknown>;
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
