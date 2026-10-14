// The passkey page, opened in a tab by the popup in Firefox, which closes popups when the passkey
// prompt appears (Mozilla bug 2026687). `?action=unlock` unlocks with the passkey; `?action=add`
// adds one, which needs the extension unlocked. The person starts it with the button, then the
// tab closes itself.
import { addPasskey, passkeyCredential, unlockWithPasskey } from '../lock/lock.js';
import { PasskeyError, createPasskey, passkeyOutput } from '../lock/passkey.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const action = new URLSearchParams(location.search).get('action') === 'add' ? 'add' : 'unlock';
const go = element<HTMLButtonElement>('go');
const error = element('error');

element('title').textContent = action === 'add' ? 'Add a passkey' : 'Unlock CometOTP';
element('lead').textContent =
  action === 'add'
    ? 'Use Touch ID, Windows Hello, your phone or a security key to unlock CometOTP. Your password keeps working.'
    : 'Use your passkey to unlock CometOTP.';

async function run(): Promise<void> {
  if (action === 'add') {
    const { credential, prf } = await createPasskey();
    await addPasskey(credential, prf);
    return;
  }
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
      document.body.dataset.done = action;
      setTimeout(() => window.close(), 1500);
    },
    (failure: unknown) => {
      go.disabled = false;
      error.textContent = failure instanceof PasskeyError || failure instanceof Error ? failure.message : String(failure);
    },
  );
});
