import React, { useEffect, useMemo, useState } from 'react';
import { BackHandler, FlatList, KeyboardAvoidingView, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Btn, Rule, Screen, T } from '../components/Terminal';
import { ONLINE_MS, useChat } from '../store';
import { C, F, glow } from '../theme';
import { useNow } from './Radar';

const MAX_OTHERS = 7;

export function NewGroupScreen({ onBack, onCreated }: { onBack: () => void; onCreated: (chatKey: string) => void }) {
  const { peers, createGroup } = useChat();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const now = useNow();

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const list = useMemo(
    () => Object.values(peers).sort((a, b) => b.lastSeen - a.lastSeen || a.handle.localeCompare(b.handle)),
    [peers]
  );
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_OTHERS ? [...p, id] : p));
  const ok = name.trim().length >= 1 && picked.length >= 1;

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable onPress={onBack} hitSlop={12}>
          <T size={16}>&lt;&lt; ABORT</T>
        </Pressable>
        <T display size={30} style={{ marginTop: 6 }}>
          OPEN NEW CHANNEL
        </T>

        <Rule label="CHANNEL NAME" />
        <View style={styles.inputRow}>
          <T size={18}>#</T>
          <TextInput
            value={name}
            onChangeText={(v) => setName(v.toUpperCase().slice(0, 24))}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="OPS"
            placeholderTextColor={C.greenFaint}
            selectionColor={C.green}
            cursorColor={C.green}
            style={[styles.input, glow]}
          />
        </View>

        <Rule label={`MEMBERS ${picked.length}/${MAX_OTHERS}`} />
        <FlatList
          style={{ flex: 1 }}
          data={list}
          keyExtractor={(p) => p.nodeId}
          ListEmptyComponent={
            <T color={C.greenDim} size={13}>
              NO KNOWN NODES. CONTACTS APPEAR HERE ONCE THEIR PHONE HAS BEEN IN RANGE.
            </T>
          }
          renderItem={({ item: p }) => {
            const on = now - p.lastSeen < ONLINE_MS;
            const sel = picked.includes(p.nodeId);
            return (
              <Pressable
                onPress={() => toggle(p.nodeId)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.greenFaint }]}
              >
                <T size={16} color={sel ? C.cyan : C.green}>
                  [{sel ? 'X' : ' '}] {p.handle}
                </T>
                <T size={12} color={on ? C.green : C.greenDim}>
                  {p.verified ? '✔ ' : ''}
                  {on ? 'IN RANGE' : 'OFFLINE'}
                </T>
              </Pressable>
            );
          }}
        />

        <T size={12} color={C.greenDim} style={{ marginVertical: 8 }}>
          EACH MESSAGE IS ENCRYPTED SEPARATELY FOR EVERY MEMBER. OFFLINE MEMBERS GET THEIR INVITE WHEN THEY COME
          BACK INTO RANGE.
        </T>
        <Btn
          label="OPEN CHANNEL"
          disabled={!ok}
          color={C.cyan}
          onPress={() => onCreated(`g:${createGroup(name.trim(), picked)}`)}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.greenDim,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  input: { flex: 1, color: C.green, fontFamily: F.mono, fontSize: 18, padding: 0, outlineWidth: 0 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.greenFaint,
  },
});
