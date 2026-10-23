import { Buffer } from 'buffer';

// Custom 128-bit UUIDs for the BLACKBOX GATT service.
export const SERVICE_UUID = '7a1c0000-b1ac-4b0c-9e55-0d15ea5e0001';
export const INBOX_UUID = '7a1c0001-b1ac-4b0c-9e55-0d15ea5e0001';
export const PROFILE_UUID = '7a1c0002-b1ac-4b0c-9e55-0d15ea5e0001';

export const MAX_MESSAGE_CHARS = 500;

/** What a peer exposes on its readable profile characteristic. */
export type Profile = { h: string; n: string; k: string };

/**
 * What travels over the air (written to the peer's inbox). Only the sender's
 * public key is visible; everything else is inside the encrypted box.
 */
export type Envelope = {
  v: 2;
  k: string; // sender public key (node id is derived from it)
  o: string; // nonce
  b: string; // nacl box of JSON(Inner)
};

export type RosterEntry = { n: string; h: string; k: string };

/** Decrypted contents of an envelope. */
export type Inner = {
  i: string; // message id
  t: number; // when the message was written
  s: number; // when this copy was sent (for replay checks)
  h: string; // sender handle
  x?: string; // text
  g?: { id: string; name: string; m: RosterEntry[] }; // set for group traffic
  c?: 'invite' | 'leave'; // group control message
};

const HEADER = 6; // [msgKey:4][index:1][total:1]

/**
 * BLE writes are tiny (MTU - 3 bytes), so a payload is split into frames
 * that carry enough header to be stitched back together on the other side.
 */
export function toFrames(payload: string, frameSize: number): Buffer[] {
  const data = Buffer.from(payload, 'utf8');
  const body = Math.max(1, frameSize - HEADER);
  const total = Math.ceil(data.length / body);
  if (total > 255) throw new Error('Message too large');
  const key = Buffer.alloc(4);
  key.writeUInt32BE(Math.floor(Math.random() * 0xffffffff), 0);
  const frames: Buffer[] = [];
  for (let i = 0; i < total; i++) {
    const head = Buffer.from([0, 0, 0, 0, i, total]);
    key.copy(head, 0);
    frames.push(Buffer.concat([head, Buffer.from(data.subarray(i * body, (i + 1) * body))]));
  }
  return frames;
}

/** Collects frames from many senders and yields complete payloads. */
export class Reassembler {
  private parts = new Map<string, { total: number; got: Map<number, Buffer>; at: number }>();

  push(sender: string, frame: Buffer): string | null {
    if (frame.length < HEADER) return null;
    const id = `${sender}:${frame.readUInt32BE(0)}`;
    const index = frame[4];
    const total = frame[5];
    if (total === 0 || index >= total) return null;
    let entry = this.parts.get(id);
    if (!entry) {
      // Bound memory so a flood of junk frames can't exhaust the app.
      if (this.parts.size >= 64) this.parts.delete(this.parts.keys().next().value!);
      entry = { total, got: new Map(), at: Date.now() };
      this.parts.set(id, entry);
    }
    entry.got.set(index, Buffer.from(frame.subarray(HEADER)));
    this.gc();
    if (entry.got.size < entry.total) return null;
    this.parts.delete(id);
    const ordered = Array.from({ length: entry.total }, (_, i) => entry!.got.get(i) ?? Buffer.alloc(0));
    return Buffer.concat(ordered).toString('utf8');
  }

  private gc() {
    const cutoff = Date.now() - 30_000;
    for (const [id, e] of this.parts) if (e.at < cutoff) this.parts.delete(id);
  }
}
