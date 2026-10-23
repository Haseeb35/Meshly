import nacl from 'tweetnacl';
import { getRandomBytes } from 'expo-crypto';
import { Buffer } from 'buffer';

// tweetnacl needs a CSPRNG; React Native has no window.crypto by default.
nacl.setPRNG((x, n) => {
  const bytes = getRandomBytes(n);
  for (let i = 0; i < n; i++) x[i] = bytes[i];
});

export type KeyPair = { publicKey: string; secretKey: string };

export const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
export const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export function newKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: b64(kp.publicKey), secretKey: b64(kp.secretKey) };
}

export function randomHex(bytes: number) {
  return Buffer.from(getRandomBytes(bytes)).toString('hex').toUpperCase();
}

const keyHash = (publicKey: string) => Buffer.from(nacl.hash(unb64(publicKey))).toString('hex').toUpperCase();

/**
 * A node ID is derived from the public key, so nobody can claim someone
 * else's ID without also holding their secret key.
 */
export function nodeIdFor(publicKey: string) {
  return keyHash(publicKey).slice(0, 12);
}

export function isValidPublicKey(publicKey: unknown): publicKey is string {
  try {
    return typeof publicKey === 'string' && unb64(publicKey).length === nacl.box.publicKeyLength;
  } catch {
    return false;
  }
}

/** Short human-checkable fingerprint of a public key, e.g. "3A9F 11C0 7B2E 90D4". */
export function fingerprint(publicKey: string) {
  const h = keyHash(publicKey).slice(12, 28);
  return h.match(/.{4}/g)!.join(' ');
}

/** Encrypt + authenticate for one recipient (Curve25519, XSalsa20-Poly1305). */
export function seal(text: string, theirPublicKey: string, mySecretKey: string) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(Buffer.from(text, 'utf8'), nonce, unb64(theirPublicKey), unb64(mySecretKey));
  return { nonce: b64(nonce), box: b64(box) };
}

export function open(box: string, nonce: string, theirPublicKey: string, mySecretKey: string) {
  try {
    const out = nacl.box.open(unb64(box), unb64(nonce), unb64(theirPublicKey), unb64(mySecretKey));
    return out ? Buffer.from(out).toString('utf8') : null;
  } catch {
    return null;
  }
}

/** Symmetric encryption for data at rest. */
export function newVaultKey() {
  return b64(nacl.randomBytes(nacl.secretbox.keyLength));
}

export function vaultSeal(text: string, key: string) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return JSON.stringify({ v: 1, n: b64(nonce), b: b64(nacl.secretbox(Buffer.from(text, 'utf8'), nonce, unb64(key))) });
}

export function vaultOpen(blob: string, key: string) {
  try {
    const { n, b } = JSON.parse(blob);
    const out = nacl.secretbox.open(unb64(b), unb64(n), unb64(key));
    return out ? Buffer.from(out).toString('utf8') : null;
  } catch {
    return null;
  }
}
