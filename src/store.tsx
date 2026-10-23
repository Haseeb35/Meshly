import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react';
import { newKeyPair, nodeIdFor, randomHex } from './crypto';
import { Inner, MAX_MESSAGE_CHARS, RosterEntry } from './protocol';
import { BleTransport } from './transport/ble';
import { SimTransport } from './transport/sim';
import { Identity, Incoming, PeerSighting, Transport } from './transport/types';
import * as vault from './vault';

export type Mode = 'live' | 'sim';

export const ONLINE_MS = 30_000;

export type Peer = PeerSighting & { lastSeen: number; unread: number; verified?: boolean };

export type Group = {
  id: string;
  name: string;
  /** Everyone in the group, including me. */
  members: RosterEntry[];
  unread: number;
  createdAt: number;
};

export type Message = {
  id: string;
  mine: boolean;
  text: string;
  ts: number;
  /** Sender, for group messages from others. */
  from?: { nodeId: string; handle: string };
  /** Mine only: who it must reach, and who confirmed receipt. */
  targets?: string[];
  acks?: string[];
  /** A group invite / roster update rather than chat text. */
  control?: 'invite';
  /** Local notice like "X left", never sent. */
  system?: boolean;
  /** Received during this session; gets the typewriter effect. */
  fresh?: boolean;
};

export type LogLine = { ts: number; line: string; level: 'info' | 'warn' | 'error' };

/** DMs are keyed by node id, groups by "g:<id>". */
export const groupKey = (id: string) => `g:${id}`;

type Convos = Record<string, Message[]>;

type State = {
  loaded: boolean;
  identity: Identity | null;
  mode: Mode | null;
  link: 'offline' | 'starting' | 'online' | 'error';
  linkError: string | null;
  peers: Record<string, Peer>;
  groups: Record<string, Group>;
  messages: Convos;
  /** "<sender>:<msgid>" of everything received, so replays are dropped. */
  seen: string[];
  /** "<msgid>|<nodeId>" deliveries in flight. */
  sending: Record<string, true>;
  logs: LogLine[];
};

type Saved = Pick<State, 'peers' | 'groups' | 'messages' | 'seen'>;

type Action =
  | { type: 'loaded'; identity: Identity | null }
  | { type: 'identity'; identity: Identity | null }
  | { type: 'history'; mode: Mode; saved: Saved }
  | { type: 'link'; mode: Mode | null; link: State['link']; error?: string | null }
  | { type: 'peer'; peer: PeerSighting }
  | { type: 'packet'; packet: Incoming; activeKey: string | null }
  | { type: 'outgoing'; key: string; msg: Message }
  | { type: 'sending'; id: string; nodeId: string; on: boolean }
  | { type: 'ack'; key: string; id: string; nodeId: string }
  | { type: 'group'; group: Group }
  | { type: 'leave'; id: string }
  | { type: 'read'; key: string }
  | { type: 'verify'; nodeId: string; verified: boolean }
  | { type: 'log'; line: LogLine }
  | { type: 'wipe' };

const MAX_HISTORY = 300;
const MAX_LOGS = 60;
const MAX_SEEN = 5000;
const MAX_GROUP = 8;
const REPLAY_WINDOW_MS = 7 * 24 * 3600_000;
const RETRY_MS = 10_000;

const empty: Saved = { peers: {}, groups: {}, messages: {}, seen: [] };

const initial: State = {
  loaded: false,
  identity: null,
  mode: null,
  link: 'offline',
  linkError: null,
  ...empty,
  sending: {},
  logs: [],
};

export const cleanHandle = (h: unknown) =>
  String(h ?? '').toUpperCase().replace(/[^A-Z0-9_\-.]/g, '').slice(0, 12) || '?';

const cleanName = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'UNNAMED';

function append(list: Message[] | undefined, msg: Message) {
  const next = [...(list ?? []), msg];
  return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
}

/** Roster entries must have a key that matches their node id. */
function validRoster(m: unknown): RosterEntry[] | null {
  if (!Array.isArray(m) || m.length > MAX_GROUP) return null;
  const out: RosterEntry[] = [];
  for (const e of m) {
    try {
      if (!e || typeof e.k !== 'string' || nodeIdFor(e.k) !== e.n) return null;
    } catch {
      return null;
    }
    if (!out.some((o) => o.n === e.n)) out.push({ n: e.n, h: cleanHandle(e.h), k: e.k });
  }
  return out;
}

function receive(s: State, { from, inner }: Incoming, activeKey: string | null): State {
  const me = s.identity;
  if (!me || from.nodeId === me.nodeId) return s;

  // Shape checks: everything below came from another device.
  if (typeof inner?.i !== 'string' || inner.i.length > 40) return s;
  if (typeof inner.s !== 'number' || typeof inner.t !== 'number') return s;
  if (inner.x != null && (typeof inner.x !== 'string' || inner.x.length > MAX_MESSAGE_CHARS)) return s;

  // Replay protection: each (sender, id) is accepted once, and stale packets are refused.
  const seenId = `${from.nodeId}:${inner.i}`;
  if (s.seen.includes(seenId)) return s;
  if (Math.abs(Date.now() - inner.s) > REPLAY_WINDOW_MS) return s;
  const seen = [...s.seen.slice(-(MAX_SEEN - 1)), seenId];

  const handle = cleanHandle(inner.h);
  const prev = s.peers[from.nodeId];
  const peers = {
    ...s.peers,
    [from.nodeId]: {
      nodeId: from.nodeId,
      publicKey: from.publicKey,
      handle,
      rssi: prev?.rssi ?? null,
      // They just reached us over the air, so they're in range.
      lastSeen: Date.now(),
      unread: prev?.unread ?? 0,
      verified: prev?.verified,
    },
  };
  const ts = Math.min(inner.t, Date.now());

  if (inner.g) {
    const roster = validRoster(inner.g.m);
    const id = typeof inner.g.id === 'string' ? inner.g.id.slice(0, 24) : '';
    if (!roster || !id) return { ...s, seen };
    const known = s.groups[id];
    // Only accept group traffic from members, and only for groups we're in.
    const senderListed = roster.some((r) => r.n === from.nodeId) || known?.members.some((r) => r.n === from.nodeId);
    if (!senderListed || !roster.some((r) => r.n === me.nodeId)) return { ...s, seen };

    const key = groupKey(id);
    let members = known ? [...known.members] : roster;
    for (const r of roster) if (!members.some((m) => m.n === r.n)) members.push(r);
    let list = s.messages[key];

    if (!known) {
      list = append(list, { id: `sys-${inner.i}`, mine: false, system: true, text: `${handle} ADDED YOU TO THIS CHANNEL`, ts });
    }
    if (inner.c === 'leave') {
      members = members.filter((m) => m.n !== from.nodeId);
      list = append(list, { id: `sys-${inner.i}`, mine: false, system: true, text: `${handle} LEFT THE CHANNEL`, ts });
    }
    const hasText = !inner.c && inner.x;
    if (hasText) {
      list = append(list, { id: inner.i, mine: false, text: inner.x!, ts, from: { nodeId: from.nodeId, handle }, fresh: true });
    }
    const group: Group = {
      id,
      name: known?.name ?? cleanName(inner.g.name),
      members: members.slice(0, MAX_GROUP),
      unread: (known?.unread ?? 0) + (hasText && activeKey !== key ? 1 : 0),
      createdAt: known?.createdAt ?? Date.now(),
    };
    return { ...s, seen, peers, groups: { ...s.groups, [id]: group }, messages: { ...s.messages, [key]: list ?? [] } };
  }

  if (!inner.x) return { ...s, seen, peers };
  const key = from.nodeId;
  peers[key] = { ...peers[key], unread: activeKey === key ? 0 : peers[key].unread + 1 };
  return {
    ...s,
    seen,
    peers,
    messages: { ...s.messages, [key]: append(s.messages[key], { id: inner.i, mine: false, text: inner.x, ts, fresh: true }) },
  };
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'loaded':
      return { ...s, loaded: true, identity: a.identity };
    case 'identity':
      return { ...s, identity: a.identity };
    case 'history':
      // Swap in this mode's history together with the mode, so it's never saved under the wrong key.
      return { ...s, mode: a.mode, link: 'starting', linkError: null, ...a.saved, sending: {} };
    case 'link':
      return a.mode
        ? { ...s, mode: a.mode, link: a.link, linkError: a.error ?? null }
        : { ...s, mode: null, link: a.link, linkError: a.error ?? null, ...empty, sending: {} };
    case 'peer': {
      const prev = s.peers[a.peer.nodeId];
      return {
        ...s,
        peers: {
          ...s.peers,
          [a.peer.nodeId]: {
            ...a.peer,
            rssi: a.peer.rssi ?? prev?.rssi ?? null,
            lastSeen: Date.now(),
            unread: prev?.unread ?? 0,
            verified: prev?.verified,
          },
        },
      };
    }
    case 'packet':
      return receive(s, a.packet, a.activeKey);
    case 'outgoing':
      return { ...s, messages: { ...s.messages, [a.key]: append(s.messages[a.key], a.msg) } };
    case 'sending': {
      const sending = { ...s.sending };
      if (a.on) sending[`${a.id}|${a.nodeId}`] = true;
      else delete sending[`${a.id}|${a.nodeId}`];
      return { ...s, sending };
    }
    case 'ack':
      return {
        ...s,
        messages: {
          ...s.messages,
          [a.key]: (s.messages[a.key] ?? []).map((m) =>
            m.id === a.id && !m.acks?.includes(a.nodeId) ? { ...m, acks: [...(m.acks ?? []), a.nodeId] } : m
          ),
        },
      };
    case 'group':
      return { ...s, groups: { ...s.groups, [a.group.id]: a.group } };
    case 'leave': {
      const { [a.id]: _, ...groups } = s.groups;
      const { [groupKey(a.id)]: __, ...messages } = s.messages;
      return { ...s, groups, messages };
    }
    case 'read': {
      if (a.key.startsWith('g:')) {
        const g = s.groups[a.key.slice(2)];
        return g && g.unread ? { ...s, groups: { ...s.groups, [g.id]: { ...g, unread: 0 } } } : s;
      }
      const p = s.peers[a.key];
      return p && p.unread ? { ...s, peers: { ...s.peers, [a.key]: { ...p, unread: 0 } } } : s;
    }
    case 'verify': {
      const p = s.peers[a.nodeId];
      return p ? { ...s, peers: { ...s.peers, [a.nodeId]: { ...p, verified: a.verified } } } : s;
    }
    case 'log':
      return { ...s, logs: [...s.logs.slice(-(MAX_LOGS - 1)), a.line] };
    case 'wipe':
      return { ...s, peers: {}, groups: {}, messages: {}, sending: {} };
  }
}

type Ctx = State & {
  createIdentity(handle: string): void;
  connect(mode: Mode): Promise<void>;
  disconnect(): void;
  send(key: string, text: string): void;
  retry(key: string, id: string): void;
  createGroup(name: string, memberIds: string[]): string;
  leaveGroup(id: string): void;
  verify(nodeId: string, verified: boolean): void;
  setActiveChat(key: string | null): void;
  wipeHistory(): void;
  burnIdentity(): Promise<void>;
  log(line: string, level?: LogLine['level']): void;
};

const ChatContext = createContext<Ctx | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const transport = useRef<Transport | null>(null);
  const activeChat = useRef<string | null>(null);
  const lastAttempt = useRef(new Map<string, number>());
  const stateRef = useRef(state);
  stateRef.current = state;

  const log = useCallback((line: string, level: LogLine['level'] = 'info') => {
    dispatch({ type: 'log', line: { ts: Date.now(), line, level } });
  }, []);

  useEffect(() => {
    (async () => {
      let identity: Identity | null = null;
      try {
        identity = await vault.loadIdentity();
      } catch (e: any) {
        log(`KEYSTORE ERROR: ${String(e?.message ?? e).toUpperCase()}`, 'error');
      }
      dispatch({ type: 'loaded', identity });
    })();
  }, [log]);

  // Persist history, encrypted (debounced).
  useEffect(() => {
    const mode = state.mode;
    if (!state.loaded || !mode) return;
    const t = setTimeout(() => {
      const keep = (id: string) => state.messages[id]?.length || state.peers[id].verified;
      const peers: Record<string, Peer> = {};
      for (const id in state.peers) if (keep(id)) peers[id] = state.peers[id];
      const messages: Convos = {};
      for (const k in state.messages) messages[k] = state.messages[k].map(({ fresh, ...m }) => m);
      vault.saveHistory(mode, { peers, groups: state.groups, messages, seen: state.seen }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [state.loaded, state.mode, state.peers, state.groups, state.messages, state.seen]);

  const createIdentity = useCallback((handle: string) => {
    const kp = newKeyPair();
    const identity: Identity = { handle, nodeId: nodeIdFor(kp.publicKey), ...kp };
    vault.saveIdentity(identity).catch(() => {});
    dispatch({ type: 'identity', identity });
  }, []);

  // ---- delivery -----------------------------------------------------------

  /** Who a message must reach, with the keys to encrypt for them. */
  const recipients = useCallback((key: string): RosterEntry[] => {
    const s = stateRef.current;
    if (key.startsWith('g:')) {
      return (s.groups[key.slice(2)]?.members ?? []).filter((m) => m.n !== s.identity?.nodeId);
    }
    const p = s.peers[key];
    return p ? [{ n: p.nodeId, h: p.handle, k: p.publicKey }] : [];
  }, []);

  const deliver = useCallback(
    (key: string, msg: Message, to: RosterEntry, groupOverride?: Group) => {
      const t = transport.current;
      const s = stateRef.current;
      const me = s.identity;
      if (!t || !me || s.sending[`${msg.id}|${to.n}`]) return;
      lastAttempt.current.set(`${msg.id}|${to.n}`, Date.now());
      const group = groupOverride ?? (key.startsWith('g:') ? s.groups[key.slice(2)] : null);
      const inner: Inner = {
        i: msg.id,
        t: msg.ts,
        s: Date.now(),
        h: me.handle,
        ...(msg.control ? { c: msg.control } : { x: msg.text }),
        ...(group ? { g: { id: group.id, name: group.name, m: group.members } } : {}),
      };
      dispatch({ type: 'sending', id: msg.id, nodeId: to.n, on: true });
      t.send({ nodeId: to.n, publicKey: to.k }, inner)
        .then(() => dispatch({ type: 'ack', key, id: msg.id, nodeId: to.n }))
        .catch((e) => {
          const reason = String(e?.message ?? e).toUpperCase();
          log(`TX -> ${to.h} QUEUED: ${reason}`, 'warn');
        })
        .finally(() => dispatch({ type: 'sending', id: msg.id, nodeId: to.n, on: false }));
    },
    [log]
  );

  /** Send everything still owed to nodes that are in range. */
  const pump = useCallback(
    (onlyNode?: string) => {
      const s = stateRef.current;
      const now = Date.now();
      for (const key in s.messages) {
        for (const msg of s.messages[key]) {
          if (!msg.mine || !msg.targets) continue;
          for (const to of recipients(key)) {
            if (onlyNode && to.n !== onlyNode) continue;
            if (!msg.targets.includes(to.n) || msg.acks?.includes(to.n)) continue;
            const peer = s.peers[to.n];
            if (!peer || now - peer.lastSeen > ONLINE_MS) continue;
            if (now - (lastAttempt.current.get(`${msg.id}|${to.n}`) ?? 0) < RETRY_MS) continue;
            deliver(key, msg, to);
          }
        }
      }
    },
    [deliver, recipients]
  );

  // Retry queued messages every few seconds while online.
  useEffect(() => {
    if (state.link !== 'online') return;
    const t = setInterval(() => pump(), 5000);
    return () => clearInterval(t);
  }, [state.link, pump]);

  const queue = useCallback(
    (key: string, msg: Omit<Message, 'targets' | 'acks' | 'mine'>, group?: Group) => {
      const to = group ? group.members.filter((m) => m.n !== stateRef.current.identity?.nodeId) : recipients(key);
      const full: Message = { ...msg, mine: true, targets: to.map((r) => r.n), acks: [] };
      dispatch({ type: 'outgoing', key, msg: full });
      const now = Date.now();
      for (const r of to) {
        const p = stateRef.current.peers[r.n];
        if (p && now - p.lastSeen < ONLINE_MS) deliver(key, full, r, group);
      }
    },
    [recipients, deliver]
  );

  // ---- connection ---------------------------------------------------------

  const disconnect = useCallback(() => {
    transport.current?.stop();
    transport.current = null;
    dispatch({ type: 'link', mode: null, link: 'offline' });
  }, []);

  const connect = useCallback(
    async (mode: Mode) => {
      const me = stateRef.current.identity;
      if (!me) return;
      transport.current?.stop();
      const t: Transport = mode === 'live' ? new BleTransport() : new SimTransport();
      transport.current = t;
      let saved = empty;
      try {
        saved = { ...empty, ...((await vault.loadHistory<Saved>(mode)) ?? {}) };
        for (const id in saved.peers) saved.peers[id] = { ...saved.peers[id], lastSeen: 0, rssi: null };
      } catch {
        log('HISTORY VAULT UNREADABLE. STARTING CLEAN.', 'warn');
      }
      if (transport.current !== t) return;
      dispatch({ type: 'history', mode, saved });
      try {
        await t.start(me, {
          onPeer: (peer) => {
            if (transport.current !== t) return;
            dispatch({ type: 'peer', peer });
            setTimeout(() => pump(peer.nodeId), 0);
          },
          onPacket: (packet) =>
            transport.current === t && dispatch({ type: 'packet', packet, activeKey: activeChat.current }),
          onLog: (line, level) => transport.current === t && log(line, level),
        });
        if (transport.current === t) dispatch({ type: 'link', mode, link: 'online' });
      } catch (e: any) {
        const error = String(e?.message ?? e);
        log(`FATAL: ${error.toUpperCase()}`, 'error');
        t.stop();
        if (transport.current === t) transport.current = null;
        dispatch({ type: 'link', mode, link: 'error', error });
      }
    },
    [log, pump]
  );

  useEffect(() => () => transport.current?.stop(), []);

  // ---- actions ------------------------------------------------------------

  const send = useCallback(
    (key: string, text: string) => queue(key, { id: randomHex(8), text, ts: Date.now() }),
    [queue]
  );

  const retry = useCallback(
    (key: string, id: string) => {
      const msg = stateRef.current.messages[key]?.find((m) => m.id === id);
      if (!msg) return;
      for (const to of recipients(key)) {
        if (msg.targets?.includes(to.n) && !msg.acks?.includes(to.n)) deliver(key, msg, to);
      }
    },
    [recipients, deliver]
  );

  const createGroup = useCallback(
    (name: string, memberIds: string[]) => {
      const s = stateRef.current;
      const me = s.identity!;
      const members: RosterEntry[] = [
        { n: me.nodeId, h: me.handle, k: me.publicKey },
        ...memberIds
          .map((id) => s.peers[id])
          .filter(Boolean)
          .slice(0, MAX_GROUP - 1)
          .map((p) => ({ n: p.nodeId, h: p.handle, k: p.publicKey })),
      ];
      const id = randomHex(6);
      const group: Group = { id, name: cleanName(name), members, unread: 0, createdAt: Date.now() };
      dispatch({ type: 'group', group });
      queue(groupKey(id), { id: randomHex(8), text: 'CHANNEL CREATED', ts: Date.now(), control: 'invite' }, group);
      log(`CHANNEL ${cleanName(name)} CREATED (${members.length} MEMBERS)`);
      return id;
    },
    [queue, log]
  );

  const leaveGroup = useCallback(
    (id: string) => {
      const s = stateRef.current;
      const group = s.groups[id];
      const me = s.identity;
      const t = transport.current;
      if (group && me && t) {
        // Best effort: tell whoever is in range, then forget the group.
        const now = Date.now();
        for (const m of group.members) {
          if (m.n === me.nodeId) continue;
          const p = s.peers[m.n];
          if (!p || now - p.lastSeen > ONLINE_MS) continue;
          t.send(
            { nodeId: m.n, publicKey: m.k },
            { i: randomHex(8), t: now, s: now, h: me.handle, c: 'leave', g: { id, name: group.name, m: group.members } }
          ).catch(() => {});
        }
      }
      dispatch({ type: 'leave', id });
    },
    []
  );

  const verify = useCallback((nodeId: string, verified: boolean) => dispatch({ type: 'verify', nodeId, verified }), []);

  const setActiveChat = useCallback((key: string | null) => {
    activeChat.current = key;
    if (key) dispatch({ type: 'read', key });
  }, []);

  const wipeHistory = useCallback(() => {
    const mode = stateRef.current.mode;
    if (mode) vault.wipeHistory(mode).catch(() => {});
    dispatch({ type: 'wipe' });
    log('HISTORY SHREDDED', 'warn');
  }, [log]);

  const burnIdentity = useCallback(async () => {
    transport.current?.stop();
    transport.current = null;
    await vault.burnEverything().catch(() => {});
    dispatch({ type: 'link', mode: null, link: 'offline' });
    dispatch({ type: 'identity', identity: null });
  }, []);

  return (
    <ChatContext.Provider
      value={{
        ...state,
        createIdentity,
        connect,
        disconnect,
        send,
        retry,
        createGroup,
        leaveGroup,
        verify,
        setActiveChat,
        wipeHistory,
        burnIdentity,
        log,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat outside ChatProvider');
  return ctx;
}
