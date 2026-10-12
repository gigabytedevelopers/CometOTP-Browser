// Writes vectors/v1.json: the test vectors for protocol v1 (docs/protocol.md), built from fixed
// inputs with Node's own crypto (OpenSSL). Every "random" value is derived from a label, so running
// this again gives the same file. Run: node vectors/generate.mjs
//
// vectors/check-jvm/CheckVectors.java recomputes everything with the Java crypto APIs Android
// uses, so the file is checked by a second, independent implementation.

import { createCipheriv, createECDH, createHash, createHmac, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const utf8 = (s) => Buffer.from(s, 'utf8');
const b64u = (b) => Buffer.from(b).toString('base64url');
const hex = (b) => Buffer.from(b).toString('hex');
const cat = (...parts) => Buffer.concat(parts);
const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const lp = (b) => cat(u16(b.length), b);
const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
const seal = (key, nonce, aad, plaintext) => {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return cat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
};
/** A fixed stand-in for a random value, so the vectors are reproducible. */
const fixed = (label, length = 32) => sha256(utf8(`CometOTP test vector ${label}`)).subarray(0, length);

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32 = (bytes) => {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
};
const unbase32 = (text) => {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of text) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

// --- Protocol constants (docs/protocol.md, "Constants") ---------------------------------------

const PAIR_LABEL = utf8('CometOTP pair v1');
const PAIR_KEYS_INFO = utf8('CometOTP pair v1 keys');
const VAULT_INFO = utf8('CometOTP vault v1');
const SERVICE_ID_LABEL = utf8('CometOTP service v1');
const BLOB_MAGIC = utf8('COV1');
const PAD_BLOCK = 4096;
const TO_BROWSER = 1;
const TO_PHONE = 2;
const STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';

// --- Pairing ----------------------------------------------------------------------------------

const relay = 'https://relay.example.com';
const browserName = 'Chrome on macOS';
const phoneName = 'Galaxy S25 Ultra';

const browserKey = createECDH('prime256v1');
browserKey.setPrivateKey(fixed('browser key'));
const phoneKey = createECDH('prime256v1');
phoneKey.setPrivateKey(fixed('phone key'));
const browserPub = browserKey.getPublicKey(null, 'uncompressed');
const phonePub = phoneKey.getPublicKey(null, 'uncompressed');

const secret = fixed('pairing secret');
const channel = fixed('channel', 16);

const uri = 'cometotp://pair?v=1'
  + `&r=${encodeURIComponent(relay)}`
  + `&c=${b64u(channel)}`
  + `&k=${b64u(browserPub)}`
  + `&s=${b64u(secret)}`
  + `&n=${encodeURIComponent(browserName)}`;

const shared = phoneKey.computeSecret(browserPub);
if (!shared.equals(browserKey.computeSecret(phonePub))) throw new Error('ECDH mismatch');

const transcript = sha256(PAIR_LABEL, lp(utf8(relay)), channel, browserPub, lp(utf8(browserName)), phonePub);
const okm = hkdf(cat(shared, secret), transcript, PAIR_KEYS_INFO, 68);
const keyToBrowser = okm.subarray(0, 32);
const keyToPhone = okm.subarray(32, 64);
const sasNumber = okm.readUInt32BE(64) % 1_000_000;
const sasDigits = String(sasNumber).padStart(6, '0');
const sas = `${sasDigits.slice(0, 3)} ${sasDigits.slice(3)}`;

// Vault credentials the phone creates once both people have confirmed the SAS.
const vaultId = fixed('vault id', 16);
const writeToken = fixed('write token');
const readToken = fixed('read token');
const vaultKey = fixed('vault key');

const pairAad = (direction, index) => cat(PAIR_LABEL, channel, u8(direction), u8(index));
const frame = (direction, index, message, withPhoneKey = false) => {
  const nonce = fixed(`nonce ${direction} ${index}`, 12);
  const key = direction === TO_BROWSER ? keyToBrowser : keyToPhone;
  const plaintext = JSON.stringify(message);
  const sealed = seal(key, nonce, pairAad(direction, index), utf8(plaintext));
  const body = cat(...(withPhoneKey ? [phonePub] : []), nonce, sealed);
  return {
    direction: direction === TO_BROWSER ? 'to-browser' : 'to-phone',
    index,
    nonce: b64u(nonce),
    aad: hex(pairAad(direction, index)),
    plaintext,
    frame: b64u(body),
  };
};

const messages = [
  frame(TO_BROWSER, 1, { t: 'hello', phone: phoneName }, true),
  frame(TO_PHONE, 1, { t: 'confirm' }),
  frame(TO_BROWSER, 2, { t: 'vault', id: b64u(vaultId), read: b64u(readToken), key: b64u(vaultKey) }),
  frame(TO_PHONE, 2, { t: 'done' }),
];

// --- Vault blob -------------------------------------------------------------------------------

const serviceId = (secretBytes) => b64u(sha256(SERVICE_ID_LABEL, secretBytes).subarray(0, 12));

const githubSecret = unbase32('JBSWY3DPEHPK3PXP');
const steamSecret = fixed('steam secret', 20);
const payload = JSON.stringify({
  v: 1,
  phone: phoneName,
  updated: 1791763200,
  services: [
    {
      id: serviceId(githubSecret),
      type: 'totp',
      secret: base32(githubSecret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      issuer: 'GitHub',
      label: 'alice@example.com',
      icon: 'Github',
      tags: ['Work'],
    },
    {
      id: serviceId(steamSecret),
      type: 'steam',
      secret: base32(steamSecret),
      algorithm: 'SHA1',
      digits: 5,
      period: 30,
      issuer: 'Steam',
      label: 'alice',
      initials: 'ST',
      badge: '#3F51B5',
    },
  ],
});

const version = 3;
const blobKey = hkdf(vaultKey, vaultId, VAULT_INFO, 32);
const padded = (() => {
  const json = utf8(payload);
  const length = Math.ceil((4 + json.length) / PAD_BLOCK) * PAD_BLOCK;
  return cat(u32(json.length), json, Buffer.alloc(length - 4 - json.length));
})();
const header = cat(BLOB_MAGIC, u64(version));
const blobNonce = fixed('blob nonce', 12);
const blob = cat(header, blobNonce, seal(blobKey, blobNonce, cat(header, vaultId), padded));

// --- Codes ------------------------------------------------------------------------------------

const hotpValue = (secretBytes, algorithm, counter) => {
  const mac = createHmac(algorithm.replace('SHA', 'sha'), secretBytes).update(u64(counter)).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return mac.readUInt32BE(offset) & 0x7fffffff;
};
const code = ({ type, secret: text, algorithm, digits, period, time }) => {
  let value = hotpValue(unbase32(text), algorithm, Math.floor(time / period));
  if (type === 'steam') {
    let out = '';
    for (let i = 0; i < digits; i++) {
      out += STEAM_CHARS[value % 26];
      value = Math.floor(value / 26);
    }
    return out;
  }
  return String(value % 10 ** digits).padStart(digits, '0');
};

// RFC 6238 appendix B: the same seeds, as base32 secrets.
const rfcSeeds = {
  SHA1: base32(utf8('12345678901234567890')),
  SHA256: base32(utf8('12345678901234567890123456789012')),
  SHA512: base32(utf8('1234567890123456789012345678901234567890123456789012345678901234')),
};
const rfcExpected = {
  59: ['94287082', '46119246', '90693936'],
  1111111109: ['07081804', '68084774', '25091201'],
  1111111111: ['14050471', '67062674', '99943326'],
  1234567890: ['89005924', '91819424', '93441116'],
  2000000000: ['69279037', '90698825', '38618901'],
  20000000000: ['65353130', '77737706', '47863826'],
};

const codes = [];
for (const [time, expected] of Object.entries(rfcExpected)) {
  ['SHA1', 'SHA256', 'SHA512'].forEach((algorithm, i) => {
    const input = { type: 'totp', secret: rfcSeeds[algorithm], algorithm, digits: 8, period: 30, time: Number(time) };
    const value = code(input);
    if (value !== expected[i]) throw new Error(`RFC 6238 mismatch at ${time} ${algorithm}: ${value}`);
    codes.push({ ...input, code: value, source: 'RFC 6238' });
  });
}
for (const input of [
  { type: 'totp', secret: rfcSeeds.SHA1, algorithm: 'SHA1', digits: 6, period: 30, time: 1111111109 },
  { type: 'totp', secret: rfcSeeds.SHA1, algorithm: 'SHA1', digits: 4, period: 30, time: 1234567890 },
  { type: 'totp', secret: rfcSeeds.SHA1, algorithm: 'SHA1', digits: 10, period: 30, time: 1234567890 },
  { type: 'totp', secret: rfcSeeds.SHA256, algorithm: 'SHA256', digits: 6, period: 60, time: 1791763200 },
  { type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, time: 1791763229 },
  { type: 'steam', secret: base32(steamSecret), algorithm: 'SHA1', digits: 5, period: 30, time: 1791763200 },
  { type: 'steam', secret: base32(steamSecret), algorithm: 'SHA1', digits: 5, period: 30, time: 2000000000 },
]) {
  codes.push({ ...input, code: code(input) });
}

// --- Inputs that must be rejected ---------------------------------------------------------------

const flip = (b64, byteFromEnd) => {
  const bytes = Buffer.from(b64, 'base64url');
  bytes[bytes.length - byteFromEnd] ^= 0x01;
  return b64u(bytes);
};
const offCurve = Buffer.from(browserPub);
offCurve[64] ^= 0x01; // y + 1 (or - 1): no longer on the curve
const reVersioned = Buffer.from(blob);
reVersioned.writeBigUInt64BE(BigInt(version + 1), 4);

const reject = [
  { what: 'hello with one ciphertext bit flipped', kind: 'frame', direction: 'to-browser', index: 1, hasPhoneKey: true, frame: flip(messages[0].frame, 20) },
  { what: 'confirm opened as index 2', kind: 'frame', direction: 'to-phone', index: 2, hasPhoneKey: false, frame: messages[1].frame },
  { what: 'vault message opened as to-phone', kind: 'frame', direction: 'to-phone', index: 2, hasPhoneKey: false, frame: messages[2].frame },
  { what: 'blob whose header claims another version', kind: 'blob', blob: b64u(reVersioned) },
  { what: 'browser public key off the curve', kind: 'public_key', key: b64u(offCurve) },
];

// --- Output -----------------------------------------------------------------------------------

const vectors = {
  protocol: 1,
  note: 'Test vectors for docs/protocol.md. Binary values are base64url without padding, except "aad" (hex) and the private keys and okm (hex).',
  pairing: {
    relay,
    browser_name: browserName,
    phone_name: phoneName,
    browser_private: hex(fixed('browser key')),
    phone_private: hex(fixed('phone key')),
    browser_public: b64u(browserPub),
    phone_public: b64u(phonePub),
    secret: b64u(secret),
    channel: b64u(channel),
    uri,
    shared: hex(shared),
    transcript: hex(transcript),
    okm: hex(okm),
    key_to_browser: b64u(keyToBrowser),
    key_to_phone: b64u(keyToPhone),
    sas,
    messages,
  },
  vault: {
    id: b64u(vaultId),
    write_token: b64u(writeToken),
    write_hash: b64u(sha256(writeToken)),
    read_token: b64u(readToken),
    read_hash: b64u(sha256(readToken)),
    key: b64u(vaultKey),
    blob_key: b64u(blobKey),
    version,
    payload,
    padded_length: padded.length,
    nonce: b64u(blobNonce),
    blob: b64u(blob),
  },
  service_ids: [
    { secret: base32(githubSecret), id: serviceId(githubSecret) },
    { secret: base32(steamSecret), id: serviceId(steamSecret) },
  ],
  codes,
  reject,
};

const out = fileURLToPath(new URL('./v1.json', import.meta.url));
writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${out}: SAS ${sas}, blob ${blob.length} bytes, ${codes.length} codes, ${reject.length} rejections`);
