import React, { useState } from 'react';
import { KeyboardAvoidingView, TextInput, View } from 'react-native';
import { Btn, Cursor, Rule, Screen, T, TypeText } from '../components/Terminal';
import { useChat } from '../store';
import { C, F, glow } from '../theme';

export function IdentityScreen() {
  const { createIdentity } = useChat();
  const [handle, setHandle] = useState('');
  const clean = handle.toUpperCase().replace(/[^A-Z0-9_\-.]/g, '').slice(0, 12);
  const ok = clean.length >= 2;

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'center' }}>
        <TypeText text="NEW OPERATOR DETECTED." size={18} />
        <TypeText text="IDENTIFY YOURSELF." size={18} color={C.amber} speed={30} />
        <Rule label="CODENAME" />
        <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 12 }}>
          <T size={22}>&gt; </T>
          <TextInput
            value={clean}
            onChangeText={setHandle}
            autoFocus
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={12}
            placeholder="GHOST"
            placeholderTextColor={C.greenFaint}
            selectionColor={C.green}
            cursorColor={C.green}
            onSubmitEditing={() => ok && createIdentity(clean)}
            style={[{ flex: 1, color: C.green, fontFamily: F.mono, fontSize: 22, padding: 0, outlineWidth: 0 }, glow]}
          />
          <Cursor size={22} />
        </View>
        <T color={C.greenDim} size={12} style={{ marginBottom: 24 }}>
          2-12 CHARS. A-Z 0-9 _ - . {'\n'}
          A KEYPAIR WILL BE FORGED ON THIS DEVICE. IT NEVER LEAVES IT.
        </T>
        <Btn label="FORGE IDENTITY" disabled={!ok} onPress={() => createIdentity(clean)} />
      </KeyboardAvoidingView>
    </Screen>
  );
}
