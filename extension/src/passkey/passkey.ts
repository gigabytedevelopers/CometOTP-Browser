// The passkey page, opened in a tab by the popup in Firefox, which closes popups when the passkey
// prompt appears (Mozilla bug 2026687), to unlock with the passkey. (Adding one happens on the
// settings page, a tab already.) The person starts it with the button, then the tab closes itself.
import { passkeyCredential, unlockWithPasskey } from '../lock/lock.js';
import { PasskeyError, passkeyOutput } from '../lock/passkey.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const go = element<HTMLButtonElement>('go');
const error = element('error');

async function run(): Promise<void> {
  const credential = await passkeyCredential();
  if (!credential) throw new Error('No passkey has been added. Use your password.');
  if (!(await unlockWithPasskey(await passkeyOutput(credential)))) {
    throw new Error('That passkey did not unlock CometOTP. Use your password.');
  }
}

go.addEventListener('click', () => {
  error.textContent = '';
  go.disabled = true;
  run().then(
    () => {
      go.hidden = true;
      element('done').hidden = false;
      document.body.dataset.done = 'unlock';
      setTimeout(() => window.close(), 1500);
    },
    (failure: unknown) => {
      go.disabled = false;
      error.textContent = failure instanceof PasskeyError || failure instanceof Error ? failure.message : String(failure);
    },
  );
});
