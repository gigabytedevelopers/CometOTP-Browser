// Passkeys through WebAuthn's PRF extension: Touch ID, Windows Hello, a phone or a security key.
// The extension asks the passkey for its PRF output on a fixed input (protocol §8), which only the
// authenticator can compute, and only after verifying the person. That output is what seals and
// opens the passkey's copy of M; nothing is sent anywhere. The relying party is the extension
// itself: the RP ID is left out, so the browser uses the extension's own origin, and no host
// permission is needed.
import { fromBase64Url, randomBytes, toBase64Url, type Bytes } from '@cometotp/protocol';

import { prfSalt } from './crypto.js';

/** Why a passkey could not be used. */
export class PasskeyError extends Error {
  constructor(
    readonly reason: 'cancelled' | 'no-prf' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

// The PRF extension's shapes, declared here as the built-in DOM types may not have them yet.
interface PrfValues {
  first: BufferSource;
}
interface PrfInputs {
  prf: { eval: PrfValues };
}
interface PrfOutputs {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

type Capabilities = Record<string, boolean | undefined>;

/** Whether this browser can unlock with a passkey: WebAuthn with the PRF extension. */
export async function passkeysSupported(): Promise<boolean> {
  const credential = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Capabilities> } })
    .PublicKeyCredential;
  if (!credential?.getClientCapabilities) return false;
  try {
    return (await credential.getClientCapabilities())['extension:prf'] === true;
  } catch {
    return false;
  }
}

/** Firefox closes extension popups when the passkey prompt appears, so there a tab is used. */
export function passkeysNeedTab(): boolean {
  return location.protocol === 'moz-extension:';
}

function failure(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) return error;
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return new PasskeyError('cancelled', 'Cancelled, or the passkey was not recognised.');
  }
  return new PasskeyError('failed', error instanceof Error ? error.message : String(error));
}

function prfOutput(credential: PublicKeyCredential): Bytes | null {
  const first = (credential.getClientExtensionResults() as PrfOutputs).prf?.results?.first;
  return first && first.byteLength === 32 ? new Uint8Array(first.slice(0)) : null;
}

/** Asks the passkey with `credential` (base64url) for its PRF output. */
export async function passkeyOutput(credential: string): Promise<Bytes> {
  try {
    const options: PublicKeyCredentialRequestOptions & { extensions: PrfInputs } = {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credential) }],
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { eval: { first: await prfSalt() } } },
    };
    const result = (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential | null;
    const output = result && prfOutput(result);
    if (!output) throw new PasskeyError('no-prf', 'This passkey cannot unlock CometOTP.');
    return output;
  } catch (error) {
    throw failure(error);
  }
}

/**
 * Creates a passkey for the extension and gets its PRF output: at once where the authenticator
 * gives it on creation, otherwise by asking the new passkey, which may prompt a second time.
 */
export async function createPasskey(): Promise<{ credential: string; prf: Bytes }> {
  let created: PublicKeyCredential | null;
  try {
    const options: PublicKeyCredentialCreationOptions & { extensions: PrfInputs } = {
      rp: { name: 'CometOTP' },
      user: { id: randomBytes(16), name: 'CometOTP', displayName: 'CometOTP extension' },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
      timeout: 120_000,
      extensions: { prf: { eval: { first: await prfSalt() } } },
    };
    created = (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential | null;
  } catch (error) {
    throw failure(error);
  }
  if (!created) throw new PasskeyError('failed', 'No passkey was created.');
  const credential = toBase64Url(new Uint8Array(created.rawId));
  const results = (created.getClientExtensionResults() as PrfOutputs).prf;
  if (!results?.enabled && !results?.results?.first) {
    throw new PasskeyError('no-prf', 'This passkey cannot unlock CometOTP. Try another, such as a security key.');
  }
  return { credential, prf: prfOutput(created) ?? (await passkeyOutput(credential)) };
}
