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

  /** Sends a message to the extension's other pages and its background; resolves with the reply. */
  function sendMessage(message: unknown): Promise<unknown>;

  const onMessage: {
    /** Call `sendResponse` before returning to reply to the sender. */
    addListener(
      callback: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => void,
    ): void;
  };
}
