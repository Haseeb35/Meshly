import { Inner } from '../protocol';

export type Identity = {
  handle: string;
  nodeId: string;
  publicKey: string;
  secretKey: string;
};

export type PeerSighting = {
  nodeId: string;
  handle: string;
  publicKey: string;
  rssi: number | null;
};

/** A decrypted, authenticated packet. `from` is proven by the box, not claimed. */
export type Incoming = {
  from: { nodeId: string; publicKey: string };
  inner: Inner;
};

export type TransportEvents = {
  onPeer(peer: PeerSighting): void;
  onPacket(packet: Incoming): void;
  onLog(line: string, level?: 'info' | 'warn' | 'error'): void;
};

export interface Transport {
  readonly kind: 'live' | 'sim';
  start(me: Identity, events: TransportEvents): Promise<void>;
  stop(): void;
  /** Encrypts for `to` and resolves once its radio acknowledged every frame. */
  send(to: { nodeId: string; publicKey: string }, inner: Inner): Promise<void>;
}
