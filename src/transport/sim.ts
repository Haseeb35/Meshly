import { newKeyPair, nodeIdFor } from '../crypto';
import { Inner } from '../protocol';
import { Identity, PeerSighting, Transport, TransportEvents } from './types';

type Bot = { handle: string; delay: number; lines: string[]; groupLines: string[] };

const BOTS: Bot[] = [
  {
    handle: 'GHOST_7',
    delay: 1800,
    lines: [
      'signal received. you are not who i expected.',
      'keep it short. they listen on 2.4ghz.',
      'meet at the old relay. midnight.',
      'copy that. going dark in 5.',
    ],
    groupLines: ['ghost here. channel is clean.', 'agreed. nobody else gets the key.'],
  },
  {
    handle: 'N3URAL',
    delay: 4200,
    lines: [
      'handshake ok. curve25519 checks out.',
      'i have the payload. 4.2mb. need a faster link.',
      'bluetooth only? respect. no towers, no logs.',
    ],
    groupLines: ['n3ural online. who else is on this channel?', 'roster looks right to me.'],
  },
  {
    handle: '0xDEAD',
    delay: 7500,
    lines: ['...', 'who gave you this frequency?', 'fine. you have 60 seconds.'],
    groupLines: ['...', 'i do not like groups.'],
  },
  {
    handle: 'PHR34K',
    delay: 11000,
    lines: ['yo! finally someone on the mesh', 'blackbox build is clean, nice work', 'ping me anytime'],
    groupLines: ['group chat over bluetooth?? sick', 'lol this is great'],
  },
];

type SimPeer = PeerSighting & { bot: Bot; secretKey: string };

/** Fake peers that wander in and out of range and reply to you. */
export class SimTransport implements Transport {
  readonly kind = 'sim' as const;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private intervals: ReturnType<typeof setInterval>[] = [];
  private peers = new Map<string, SimPeer>();
  private replyIndex = new Map<string, number>();
  private ev!: TransportEvents;

  async start(_me: Identity, events: TransportEvents) {
    this.ev = events;
    events.onLog('SIMULATION MODE :: NO RADIO USED');
    events.onLog('SPAWNING VIRTUAL NODES...');

    for (const bot of BOTS) {
      this.timers.push(
        setTimeout(() => {
          const kp = newKeyPair();
          const peer: SimPeer = {
            nodeId: nodeIdFor(kp.publicKey),
            handle: bot.handle,
            publicKey: kp.publicKey,
            secretKey: kp.secretKey,
            rssi: -50 - Math.floor(Math.random() * 40),
            bot,
          };
          this.peers.set(peer.nodeId, peer);
          events.onLog(`NODE IDENTIFIED: ${bot.handle} [${peer.nodeId.slice(0, 6)}]`);
          events.onPeer(this.sighting(peer));
          if (bot === BOTS[0]) this.timers.push(setTimeout(() => this.reply(peer), 4000));
        }, bot.delay)
      );
    }

    // Signal strength drifts like a real radio.
    this.intervals.push(
      setInterval(() => {
        for (const p of this.peers.values()) {
          p.rssi = Math.max(-98, Math.min(-35, (p.rssi ?? -70) + Math.round((Math.random() - 0.5) * 10)));
          events.onPeer(this.sighting(p));
        }
      }, 2500)
    );
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    this.timers = [];
    this.intervals = [];
  }

  async send(to: { nodeId: string }, inner: Inner) {
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 600));
    const peer = this.peers.get(to.nodeId);
    if (!peer) throw new Error('Peer not in radio range');
    if (inner.x?.trim().toLowerCase() === 'fail') throw new Error('Simulated link drop');
    if (inner.c) return; // invites / leaves need no answer
    this.timers.push(setTimeout(() => this.reply(peer, inner.g), 1500 + Math.random() * 3000));
  }

  private sighting({ bot, secretKey, ...p }: SimPeer): PeerSighting {
    return { ...p };
  }

  private reply(peer: SimPeer, group?: Inner['g']) {
    const key = group ? `${group.id}:${peer.nodeId}` : peer.nodeId;
    const lines = group ? peer.bot.groupLines : peer.bot.lines;
    const i = this.replyIndex.get(key) ?? 0;
    this.replyIndex.set(key, i + 1);
    const now = Date.now();
    this.ev.onPacket({
      from: { nodeId: peer.nodeId, publicKey: peer.publicKey },
      inner: { i: `${peer.nodeId}-${now}`, t: now, s: now, h: peer.handle, x: lines[i % lines.length], g: group },
    });
  }
}
