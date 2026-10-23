import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { newVaultKey, nodeIdFor, vaultOpen, vaultSeal } from './crypto';
import { Identity } from './transport/types';

/**
 * Secrets (identity keypair, history key) live in the iOS Keychain / Android
 * Keystore, never leave this device, and aren't included in backups.
 * Chat history sits in AsyncStorage but encrypted with the history key.
 */
const secure = {
  get(key: string) {
    if (Platform.OS === 'web') return AsyncStorage.getItem(key);
    return SecureStore.getItemAsync(key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
  set(key: string, value: string) {
    if (Platform.OS === 'web') return AsyncStorage.setItem(key, value);
    return SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
  del(key: string) {
    if (Platform.OS === 'web') return AsyncStorage.removeItem(key);
    return SecureStore.deleteItemAsync(key);
  },
};

const K_IDENTITY = 'bb.identity';
const K_VAULT_KEY = 'bb.vaultkey';
const historyKey = (mode: string) => `bb.vault.${mode}`;
// Plaintext storage used by earlier builds.
const LEGACY = ['bb.identity', 'bb.history', 'bb.history.live', 'bb.history.sim'];

export async function loadIdentity(): Promise<Identity | null> {
  let raw = await secure.get(K_IDENTITY);
  if (!raw && Platform.OS !== 'web') {
    // Move an identity from the old plaintext store into the keystore.
    raw = await AsyncStorage.getItem(K_IDENTITY);
    if (raw) await secure.set(K_IDENTITY, raw);
  }
  if (Platform.OS !== 'web') await AsyncStorage.multiRemove(LEGACY).catch(() => {});
  if (!raw) return null;
  const identity = JSON.parse(raw) as Identity;
  // Older identities used a random node id; it is now derived from the key.
  const nodeId = nodeIdFor(identity.publicKey);
  if (identity.nodeId !== nodeId) {
    identity.nodeId = nodeId;
    await secure.set(K_IDENTITY, JSON.stringify(identity));
  }
  return identity;
}

export const saveIdentity = (identity: Identity) => secure.set(K_IDENTITY, JSON.stringify(identity));

let vaultKey: Promise<string> | null = null;
function getVaultKey() {
  vaultKey ??= (async () => {
    const existing = await secure.get(K_VAULT_KEY);
    if (existing) return existing;
    const key = newVaultKey();
    await secure.set(K_VAULT_KEY, key);
    return key;
  })();
  return vaultKey;
}

export async function loadHistory<T>(mode: string): Promise<T | null> {
  const blob = await AsyncStorage.getItem(historyKey(mode));
  if (!blob) return null;
  const json = vaultOpen(blob, await getVaultKey());
  return json ? (JSON.parse(json) as T) : null;
}

export async function saveHistory(mode: string, data: unknown) {
  await AsyncStorage.setItem(historyKey(mode), vaultSeal(JSON.stringify(data), await getVaultKey()));
}

export const wipeHistory = (mode: string) => AsyncStorage.removeItem(historyKey(mode));

/** Destroys identity, keys and every conversation. */
export async function burnEverything() {
  await AsyncStorage.multiRemove([historyKey('live'), historyKey('sim'), ...LEGACY]);
  await secure.del(K_IDENTITY);
  await secure.del(K_VAULT_KEY);
  vaultKey = null;
}
