import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, KeyboardAvoidingView, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { fingerprint } from '../crypto';
import { MAX_MESSAGE_CHARS } from '../protocol';
import { Btn, Cursor, Rule, Screen, T, TypeText } from '../components/Terminal';
import { Message, ONLINE_MS, useChat } from '../store';
import { C, F, glow } from '../theme';
import { bars, clock, useNow } from './Radar';

// Messages that already played their typewriter animation (survives list re-renders).
const typed = new Set<string>();

function Line({
  m,
  handle,
  isGroup,
  sendingCount,
  onRetry,
}: {
  m: Message;
  handle: string;
  isGroup: boolean;
  sendingCount: number;
  onRetry: () => void;
}) {
  if (m.system) {
    return (
      <T size={12} color={C.amber} style={styles.system}>
        ** {m.text} **
      </T>
    );
  }
  const total = m.targets?.length ?? 0;
  const acked = m.acks?.length ?? 0;
  const done = acked >= total;
  const queued = total - acked - sendingCount;

  let status = '';
  let statusColor: string = C.greenDim;
  if (m.mine) {
    if (done) status = isGroup ? `✓ ACK ${acked}/${total}` : '✓ ACK';
    else if (sendingCount && !queued) status = 'TRANSMITTING...';
    else {
      status = isGroup
        ? `ACK ${acked}/${total} // ${queued} QUEUED // TAP TO RETRY`
        : '◌ QUEUED // SENDS WHEN IN RANGE // TAP TO RETRY';
      statusColor = C.amber;
    }
  }

  if (m.control === 'invite') {
    return (
      <Pressable disabled={done} onPress={onRetry} style={styles.system}>
        <T size={12} color={C.amber} style={{ textAlign: 'center' }}>
          ** YOU OPENED THIS CHANNEL **
        </T>
        <T size={11} color={statusColor} style={{ textAlign: 'center' }}>
          INVITES {status.replace('✓ ', '')}
        </T>
      </Pressable>
    );
  }

  const who = m.mine ? 'YOU' : m.from?.handle ?? handle;
  const color = m.mine ? C.cyan : C.green;
  const animate = !m.mine && m.fresh && !typed.has(m.id);
  return (
    <Pressable disabled={!m.mine || done} onPress={onRetry} style={styles.line}>
      <T size={11} color={C.greenDim}>
        [{clock(m.ts)}] {who}&gt;
      </T>
      {animate ? (
        <TypeText text={m.text} color={color} size={15} speed={22} onDone={() => typed.add(m.id)} />
      ) : (
        <T color={color} size={15}>
          {m.text}
        </T>
      )}
      {m.mine && (
        <T size={11} color={statusColor} style={{ textAlign: 'right' }}>
          {status}
        </T>
      )}
    </Pressable>
  );
}

function VerifyPanel({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { identity, peers, verify } = useChat();
  const peer = peers[nodeId];
  if (!peer || !identity) return null;
  return (
    <View style={styles.panel}>
      <T size={14} color={C.amber}>
        VERIFY {peer.handle} IN PERSON
      </T>
      <T size={12} color={C.greenDim} style={{ marginTop: 6 }}>
        Meet face to face and compare. {peer.handle}'s screen must show these same two codes. If anything
        differs, someone may be impersonating them.
      </T>
      <T size={12} color={C.greenDim} style={{ marginTop: 10 }}>
        {peer.handle}'S KEY
      </T>
      <T size={20} display>
        {fingerprint(peer.publicKey)}
      </T>
      <T size={12} color={C.greenDim} style={{ marginTop: 6 }}>
        YOUR KEY
      </T>
      <T size={20} display>
        {fingerprint(identity.publicKey)}
      </T>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        {peer.verified ? (
          <Btn label="REVOKE" color={C.red} size={13} style={{ flex: 1 }} onPress={() => (verify(nodeId, false), onClose())} />
        ) : (
          <Btn label="CODES MATCH" size={13} style={{ flex: 1 }} onPress={() => (verify(nodeId, true), onClose())} />
        )}
        <Btn label="CLOSE" color={C.greenDim} size={13} style={{ flex: 1 }} onPress={onClose} />
      </View>
    </View>
  );
}

export function ChatScreen({ chatKey, onBack }: { chatKey: string; onBack: () => void }) {
  const { identity, peers, groups, messages, sending, send, retry, setActiveChat, leaveGroup } = useChat();
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState(false);
  const list = useRef<FlatList<Message>>(null);
  const now = useNow();

  const isGroup = chatKey.startsWith('g:');
  const group = isGroup ? groups[chatKey.slice(2)] : null;
  const peer = isGroup ? null : peers[chatKey];
  const msgs = messages[chatKey] ?? [];
  const unread = group?.unread ?? peer?.unread ?? 0;

  useEffect(() => {
    setActiveChat(chatKey);
    return () => setActiveChat(null);
  }, [chatKey, setActiveChat]);

  // Keep unread at zero while this chat is open.
  useEffect(() => {
    if (unread) setActiveChat(chatKey);
  }, [unread, chatKey, setActiveChat]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  // The group was left (or shredded) while open.
  useEffect(() => {
    if (!group && !peer) onBack();
  }, [group, peer, onBack]);
  if (!group && !peer) return null;

  const online = (id: string) => {
    const p = peers[id];
    return !!p && now - p.lastSeen < ONLINE_MS;
  };
  const others = group ? group.members.filter((m) => m.n !== identity?.nodeId) : [];
  const anyOnline = group ? others.some((m) => online(m.n)) : online(chatKey);

  const sendingCount = (m: Message) => (m.targets ?? []).filter((n) => sending[`${m.id}|${n}`]).length;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send(chatKey, text);
    setDraft('');
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={styles.header}>
          <Pressable onPress={onBack} hitSlop={12}>
            <T size={16}>&lt;&lt; BACK</T>
          </Pressable>
          {peer ? (
            <T size={12} color={anyOnline ? C.green : C.red}>
              {anyOnline ? `● LINKED ${peer.rssi ?? '--'}dBm ${bars(peer.rssi)}` : '○ SIGNAL LOST'}
            </T>
          ) : (
            <Pressable onPress={() => leaveGroup(group!.id)} hitSlop={12}>
              <T size={13} color={C.red}>
                [ LEAVE ]
              </T>
            </Pressable>
          )}
        </View>

        <T display size={28} style={{ marginTop: 6 }} numberOfLines={1}>
          {group ? `CHANNEL :: ${group.name}` : `SECURE LINK :: ${peer!.handle}`}
        </T>

        {peer ? (
          <Pressable onPress={() => setPanel((v) => !v)} hitSlop={6}>
            <T size={11} color={C.greenDim}>
              NODE {peer.nodeId} // FP {fingerprint(peer.publicKey)}
            </T>
            <T size={12} color={peer.verified ? C.green : C.amber}>
              {peer.verified ? '✔ IDENTITY VERIFIED IN PERSON' : '⚠ UNVERIFIED // TAP TO VERIFY'}
            </T>
          </Pressable>
        ) : (
          <T size={12} color={C.greenDim}>
            {others.map((m) => `${online(m.n) ? '●' : '○'} ${m.h}`).join('   ')}
          </T>
        )}

        <Rule label={group ? `E2E // ${group.members.length} MEMBERS` : 'E2E ENCRYPTED // CURVE25519'} />

        {panel && peer && <VerifyPanel nodeId={peer.nodeId} onClose={() => setPanel(false)} />}

        <FlatList
          ref={list}
          style={{ flex: 1 }}
          data={msgs}
          keyExtractor={(m) => m.id}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={{ paddingTop: 20 }}>
              <T color={C.greenDim} size={13}>
                CHANNEL OPEN. NO TRAFFIC YET.
              </T>
              <T color={C.greenDim} size={13} style={{ marginTop: 8 }}>
                ONLY THE PEOPLE IN THIS CHAT CAN READ IT. EVERY MESSAGE IS ENCRYPTED SEPARATELY FOR EACH OF THEM.
              </T>
            </View>
          }
          renderItem={({ item }) => (
            <Line
              m={item}
              handle={peer?.handle ?? '?'}
              isGroup={isGroup}
              sendingCount={sendingCount(item)}
              onRetry={() => retry(chatKey, item.id)}
            />
          )}
        />

        {!anyOnline && (
          <T color={C.amber} size={12} style={{ marginBottom: 6 }}>
            !! {group ? 'NO MEMBERS' : 'NODE'} IN RANGE. MESSAGES WILL QUEUE AND SEND AUTOMATICALLY WHEN THEY RETURN.
          </T>
        )}
        <View style={styles.inputRow}>
          <T size={18}>&gt;</T>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="type message"
            placeholderTextColor={C.greenFaint}
            selectionColor={C.green}
            cursorColor={C.green}
            maxLength={MAX_MESSAGE_CHARS}
            onSubmitEditing={submit}
            submitBehavior="submit"
            returnKeyType="send"
            autoCorrect={false}
            // Keep messages out of the keyboard's learning / clipboard suggestions.
            autoComplete="off"
            importantForAutofill="no"
            spellCheck={false}
            style={[styles.input, glow]}
          />
          {!draft && <Cursor size={16} />}
        </View>
        <View style={styles.footer}>
          <T size={11} color={C.greenDim}>
            {draft.length}/{MAX_MESSAGE_CHARS}
          </T>
          <Btn label="TX" onPress={submit} disabled={!draft.trim()} size={14} style={{ paddingVertical: 6, paddingHorizontal: 18 }} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  line: { marginBottom: 12 },
  system: { marginVertical: 8, textAlign: 'center' },
  panel: { borderWidth: 1, borderColor: C.amber, padding: 12, marginBottom: 10, backgroundColor: C.panel },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.greenDim,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  input: { flex: 1, color: C.green, fontFamily: F.mono, fontSize: 16, padding: 0, outlineWidth: 0 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
});
