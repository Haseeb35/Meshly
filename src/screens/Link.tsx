import React from 'react';
import { ScrollView, View } from 'react-native';
import { fingerprint } from '../crypto';
import { Btn, Rule, Screen, T } from '../components/Terminal';
import { liveAvailable } from '../transport/ble';
import { useChat } from '../store';
import { C } from '../theme';
import { BANNER } from './Boot';

export function LinkScreen() {
  const { identity, connect, link, linkError } = useChat();
  if (!identity) return null;
  const starting = link === 'starting';

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
        <T size={11} style={{ lineHeight: 13, marginBottom: 18 }}>
          {BANNER}
        </T>
        <T size={14}>OPERATOR ..... {identity.handle}</T>
        <T size={14}>NODE ID ...... {identity.nodeId}</T>
        <T size={14}>KEY FP ....... {fingerprint(identity.publicKey)}</T>

        <Rule label="SELECT UPLINK" />

        <Btn
          label={starting ? 'INITIALISING...' : '1 :: LIVE BLUETOOTH'}
          disabled={!liveAvailable || starting}
          onPress={() => connect('live')}
          style={{ marginTop: 8 }}
        />
        <T color={C.greenDim} size={12} style={{ marginTop: 6 }}>
          {liveAvailable
            ? 'TALK TO REAL PHONES WITHIN ~10-30M. BOTH NEED BLACKBOX OPEN.'
            : 'UNAVAILABLE IN THIS BUILD (EXPO GO / WEB). NEEDS A DEV BUILD.'}
        </T>

        <Btn label="2 :: SIMULATION" onPress={() => connect('sim')} disabled={starting} style={{ marginTop: 18 }} />
        <T color={C.greenDim} size={12} style={{ marginTop: 6 }}>
          FAKE NODES THAT TALK BACK. NO HARDWARE NEEDED.
        </T>

        {link === 'error' && linkError ? (
          <View style={{ marginTop: 22, borderWidth: 1, borderColor: C.red, padding: 10 }}>
            <T color={C.red} size={14}>
              !! UPLINK FAILED
            </T>
            <T color={C.red} size={13}>
              {linkError.toUpperCase()}
            </T>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
