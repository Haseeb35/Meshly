import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, FlatList, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Btn, Cursor, Rule, Screen, T } from '../components/Terminal';
import { Group, groupKey, ONLINE_MS, Peer, useChat } from '../store';
import { C } from '../theme';

const SIZE = 190;

export const isOnline = (p: Peer, now = Date.now()) => now - p.lastSeen < ONLINE_MS;

export function bars(rssi: number | null) {
  if (rssi == null) return '▯▯▯▯▯';
  const n = rssi >= -55 ? 5 : rssi >= -65 ? 4 : rssi >= -75 ? 3 : rssi >= -85 ? 2 : 1;
  return '▮'.repeat(n) + '▯'.repeat(5 - n);
}

export const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8);

/** Re-render every few seconds so ONLINE/LOST labels stay current. */
export function useNow(ms = 2000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function hashAngle(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ((h % 360) * Math.PI) / 180;
}

function Blip({ peer }: { peer: Peer }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [pulse]);
  const rssi = peer.rssi ?? -80;
  const dist = Math.min(0.92, Math.max(0.22, (-rssi - 35) / 65)) * (SIZE / 2);
  const ang = hashAngle(peer.nodeId);
  const x = SIZE / 2 + Math.cos(ang) * dist;
  const y = SIZE / 2 + Math.sin(ang) * dist;
  const color = peer.unread ? C.amber : C.green;
  return (
    <View style={{ position: 'absolute', left: x - 4, top: y - 4 }}>
      <Animated.View
        style={[
          styles.ring,
          {
            borderColor: color,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 3.5] }) }],
          },
        ]}
      />
      <View style={[styles.dot, { backgroundColor: color, shadowColor: color }]} />
      <T size={9} color={color} style={styles.blipLabel}>
        {peer.handle}
      </T>
    </View>
  );
}

function RadarScope({ peers }: { peers: Peer[] }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 3200, easing: Easing.linear, useNativeDriver: true })
    );
    a.start();
    return () => a.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={styles.scope}>
      {[1, 0.66, 0.33].map((f) => (
        <View
          key={f}
          style={[
            styles.circle,
            { width: SIZE * f, height: SIZE * f, borderRadius: (SIZE * f) / 2, left: (SIZE * (1 - f)) / 2, top: (SIZE * (1 - f)) / 2 },
          ]}
        />
      ))}
      <View style={[styles.cross, { width: SIZE, height: 1, top: SIZE / 2 }]} />
      <View style={[styles.cross, { width: 1, height: SIZE, left: SIZE / 2 }]} />
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}>
        {/* trailing wedge: a fan of fading lines behind the beam */}
        {Array.from({ length: 14 }, (_, i) => (
          <View
            key={i}
            style={[
              styles.beam,
              { opacity: i === 0 ? 0.9 : 0.28 - i * 0.018, transform: [{ rotate: `${-i * 2.4}deg` }] },
            ]}
          />
        ))}
      </Animated.View>
      {peers.map((p) => (
        <Blip key={p.nodeId} peer={p} />
      ))}
      <View style={styles.center} />
    </View>
  );
}

type Row = { kind: 'peer'; peer: Peer } | { kind: 'group'; group: Group };

export function RadarScreen({ onOpen, onNewGroup }: { onOpen: (chatKey: string) => void; onNewGroup: () => void }) {
  const { identity, mode, link, peers, groups, messages, logs, disconnect, wipeHistory, burnIdentity } = useChat();
  const now = useNow();

  const list = useMemo(
    () =>
      Object.values(peers).sort(
        (a, b) =>
          Number(isOnline(b, now)) - Number(isOnline(a, now)) ||
          b.unread - a.unread ||
          (b.rssi ?? -999) - (a.rssi ?? -999)
      ),
    [peers, now]
  );
  const online = list.filter((p) => isOnline(p, now));
  const rows: Row[] = [
    ...Object.values(groups)
      .sort((a, b) => b.unread - a.unread || b.createdAt - a.createdAt)
      .map((group) => ({ kind: 'group' as const, group })),
    ...list.map((peer) => ({ kind: 'peer' as const, peer })),
  ];

  const confirmWipe = () => {
    if (Platform.OS === 'web') return wipeHistory();
    Alert.alert('SHRED', 'Choose what to destroy. This cannot be undone.', [
      { text: 'ABORT', style: 'cancel' },
      { text: 'SHRED ALL MESSAGES', style: 'destructive', onPress: wipeHistory },
      {
        text: 'BURN IDENTITY + KEYS',
        style: 'destructive',
        onPress: () =>
          Alert.alert('BURN IDENTITY?', 'Your codename, keys and every chat are erased. Contacts will see you as a new person.', [
            { text: 'ABORT', style: 'cancel' },
            { text: 'BURN', style: 'destructive', onPress: () => void burnIdentity() },
          ]),
      },
    ]);
  };

  return (
    <Screen>
      <View style={styles.header}>
        <T display size={28}>
          BLACKBOX
        </T>
        <T color={mode === 'live' ? C.cyan : C.amber} size={13}>
          [{mode === 'live' ? 'LIVE RF' : 'SIMULATION'}]
        </T>
      </View>
      <View style={styles.header}>
        <T color={C.greenDim} size={12}>
          OP {identity?.handle} // NODE {identity?.nodeId.slice(0, 6)}
        </T>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T color={link === 'online' ? C.green : C.amber} size={12}>
            {link === 'online' ? 'SCANNING ' : link.toUpperCase() + ' '}
          </T>
          <Cursor size={10} color={link === 'online' ? C.green : C.amber} />
        </View>
      </View>

      <View style={{ alignItems: 'center', marginVertical: 10 }}>
        <RadarScope peers={online} />
        <T color={C.greenDim} size={12} style={{ marginTop: 6 }}>
          {online.length} NODE{online.length === 1 ? '' : 'S'} IN RANGE
        </T>
      </View>

      <Rule label="CONTACTS" />
      <FlatList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(r) => (r.kind === 'group' ? groupKey(r.group.id) : r.peer.nodeId)}
        ListEmptyComponent={
          <T color={C.greenDim} size={13} style={{ textAlign: 'center', marginTop: 16 }}>
            NO NODES YET. KEEP BLACKBOX OPEN ON{'\n'}ANOTHER PHONE NEARBY...
          </T>
        }
        renderItem={({ item }) => {
          if (item.kind === 'group') {
            const g = item.group;
            const key = groupKey(g.id);
            const last = messages[key]?.filter((m) => !m.system && !m.control).at(-1);
            const inRange = g.members.filter((m) => m.n !== identity?.nodeId && peers[m.n] && isOnline(peers[m.n], now)).length;
            return (
              <Pressable
                onPress={() => onOpen(key)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.greenFaint }]}
              >
                <View style={styles.rowTop}>
                  <T size={16} color={C.cyan}>
                    #  {g.name}
                  </T>
                  <T size={12} color={inRange ? C.green : C.greenDim}>
                    {inRange}/{g.members.length - 1} IN RANGE
                  </T>
                </View>
                <View style={styles.rowTop}>
                  <T size={12} color={C.greenDim} numberOfLines={1} style={{ flex: 1 }}>
                    {'   '}
                    {last ? `${last.mine ? 'YOU' : last.from?.handle}> ${last.text}` : `${g.members.length} MEMBERS`}
                  </T>
                  {g.unread ? (
                    <T size={12} color={C.amber}>
                      {' '}
                      [{g.unread} NEW]
                    </T>
                  ) : null}
                </View>
              </Pressable>
            );
          }
          const p = item.peer;
          const on = isOnline(p, now);
          const last = messages[p.nodeId]?.at(-1);
          return (
            <Pressable
              onPress={() => onOpen(p.nodeId)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.greenFaint }]}
            >
              <View style={styles.rowTop}>
                <T size={16} color={on ? C.green : C.greenDim}>
                  {p.verified ? '✔' : '>'} {p.handle}
                </T>
                <T size={12} color={on ? C.green : C.greenDim}>
                  {on ? `${p.rssi ?? '--'}dBm ${bars(p.rssi)}` : 'SIGNAL LOST'}
                </T>
              </View>
              <View style={styles.rowTop}>
                <T size={12} color={C.greenDim} numberOfLines={1} style={{ flex: 1 }}>
                  {'   '}
                  {last ? `${last.mine ? 'YOU' : p.handle}> ${last.text}` : `NODE ${p.nodeId.slice(0, 6)}`}
                </T>
                {p.unread ? (
                  <T size={12} color={C.amber}>
                    {' '}
                    [{p.unread} NEW]
                  </T>
                ) : null}
              </View>
            </Pressable>
          );
        }}
      />

      <Rule label="SYSLOG" />
      <View style={styles.console}>
        {logs.slice(-5).map((l, i) => (
          <T
            key={l.ts + ':' + i}
            size={11}
            numberOfLines={1}
            color={l.level === 'error' ? C.red : l.level === 'warn' ? C.amber : C.greenDim}
          >
            {clock(l.ts)} {l.line}
          </T>
        ))}
      </View>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
        <Btn label="EXIT" onPress={disconnect} style={{ flex: 1 }} size={14} />
        <Btn label="+ CHANNEL" onPress={onNewGroup} color={C.cyan} style={{ flex: 1.4 }} size={14} />
        <Btn label="SHRED" onPress={confirmWipe} color={C.red} style={{ flex: 1 }} size={14} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scope: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, overflow: 'hidden', backgroundColor: '#010d03' },
  circle: { position: 'absolute', borderWidth: 1, borderColor: C.greenFaint },
  cross: { position: 'absolute', backgroundColor: C.greenFaint },
  beam: {
    position: 'absolute',
    left: SIZE / 2,
    top: SIZE / 2 - 1,
    width: SIZE / 2,
    height: 2,
    backgroundColor: C.green,
    transformOrigin: 'left center',
  },
  center: {
    position: 'absolute',
    left: SIZE / 2 - 3,
    top: SIZE / 2 - 3,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.green,
  },
  dot: { width: 8, height: 8, borderRadius: 4, shadowOpacity: 1, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  ring: { position: 'absolute', width: 8, height: 8, borderRadius: 4, borderWidth: 1 },
  blipLabel: { position: 'absolute', left: 10, top: -3, width: 80 },
  row: { paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: C.greenFaint },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  console: { height: 5 * 15, overflow: 'hidden' },
});
