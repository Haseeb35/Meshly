import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';
import { Btn, Cursor, Screen, T } from './components/Terminal';
import { C } from './theme';

export type LockState = 'checking' | 'locked' | 'unlocked' | 'unavailable';

/**
 * Requires the phone's biometrics / passcode on launch and again whenever the
 * app returns from the background. Devices with no screen lock skip it.
 */
export function useAppLock() {
  const [state, setState] = useState<LockState>('checking');
  const hasLock = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        hasLock.current =
          Platform.OS !== 'web' &&
          (await LocalAuthentication.hasHardwareAsync()) &&
          (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE;
      } catch {
        hasLock.current = false;
      }
      setState(hasLock.current ? 'locked' : 'unavailable');
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' && hasLock.current) setState('locked');
    });
    return () => sub.remove();
  }, []);

  const unlock = useCallback(async () => {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock BLACKBOX',
      cancelLabel: 'Cancel',
    });
    if (r.success) setState('unlocked');
    return r.success;
  }, []);

  return { state, unlock };
}

export function LockScreen({ unlock }: { unlock: () => Promise<boolean> }) {
  const [denied, setDenied] = useState(false);
  const tryUnlock = useCallback(async () => {
    setDenied(!(await unlock()));
  }, [unlock]);

  useEffect(() => {
    tryUnlock();
  }, [tryUnlock]);

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <T display size={40} color={denied ? C.red : C.green}>
          {denied ? 'ACCESS DENIED' : 'TERMINAL LOCKED'}
        </T>
        <T size={14} color={C.greenDim} style={{ marginVertical: 12 }}>
          AUTHENTICATE WITH YOUR FINGERPRINT, FACE OR DEVICE PASSCODE.
        </T>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 24 }}>
          <T size={16}>&gt; AWAITING OPERATOR </T>
          <Cursor size={16} />
        </View>
        <Btn label="AUTHENTICATE" onPress={tryUnlock} />
      </View>
    </Screen>
  );
}

/** Blocks screenshots / screen recording and hides chats in the app switcher. */
export function ScreenShield() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    ScreenCapture.preventScreenCaptureAsync('blackbox').catch(() => {});
    if (Platform.OS === 'ios') ScreenCapture.enableAppSwitcherProtectionAsync(1).catch(() => {});
    return () => {
      ScreenCapture.allowScreenCaptureAsync('blackbox').catch(() => {});
    };
  }, []);
  return null;
}
