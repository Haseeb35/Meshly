import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import Peripheral from '../../modules/ble-peripheral';
import { isValidPublicKey, nodeIdFor, open, seal } from '../crypto';
import {
  Envelope,
  Inner,
  INBOX_UUID,
  PROFILE_UUID,
  Profile,
  Reassembler,
  SERVICE_UUID,
  toFrames,
} from '../protocol';
import { Identity, PeerSighting, Transport, TransportEvents } from './types';

/** True when the app runs in a real native build (not Expo Go / web). */
export const liveAvailable = Platform.OS !== 'web' && Peripheral != null;

const PROBE_RETRY_MS = 15_000;
const SIGHTING_THROTTLE_MS = 2_000;

async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const P = PermissionsAndroid.PERMISSIONS;
  const wanted =
    (Platform.Version as number) >= 31
      ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT, P.BLUETOOTH_ADVERTISE]
      : [P.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
}

function waitForPoweredOn(manager: BleManager, log: TransportEvents['onLog']) {
  return new Promise<void>((resolve, reject) => {
    let warned = false;
    const sub = manager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        sub.remove();
        resolve();
      } else if (state === State.Unauthorized) {
        sub.remove();
        reject(new Error('Bluetooth permission denied'));
      } else if (state === State.Unsupported) {
        sub.remove();
        reject(new Error('Bluetooth LE not supported on this device'));
      } else if (state === State.PoweredOff && !warned) {
        warned = true;
        log('BLUETOOTH IS OFF. TURN IT ON TO CONTINUE...', 'warn');
      }
    }, true);
  });
}

/**
 * Every phone is both:
 *  - a peripheral: advertises SERVICE_UUID, exposes its profile, accepts writes to its inbox
 *  - a central: scans for SERVICE_UUID, reads profiles, writes messages to other inboxes
 */
export class BleTransport implements Transport {
  readonly kind = 'live' as const;

  private manager: BleManager | null = null;
  private me!: Identity;
  private ev!: TransportEvents;
  private subs: { remove(): void }[] = [];
  private reassembler = new Reassembler();

  // deviceId <-> nodeId mapping, learned by reading each device's profile.
  private deviceToPeer = new Map<string, PeerSighting>();
  private nodeToDevice = new Map<string, string>();
  private probing = new Set<string>();
  private probeFailedAt = new Map<string, number>();
  private lastSighting = new Map<string, number>();
  private connected = new Map<string, Device>();
  private disconnectSubs = new Map<string, Subscription>();
  private locks = new Map<string, Promise<unknown>>();

  async start(me: Identity, events: TransportEvents) {
    this.me = me;
    this.ev = events;
    if (!Peripheral) throw new Error('Native Bluetooth module missing. Use a development build.');

    events.onLog('REQUESTING RADIO PERMISSIONS...');
    if (!(await requestAndroidPermissions())) throw new Error('Bluetooth permissions were denied');

    this.manager = new BleManager();
    events.onLog('WAITING FOR TRANSCEIVER...');
    await waitForPoweredOn(this.manager, events.onLog);
    events.onLog('TRANSCEIVER ONLINE');

    this.subs.push(
      Peripheral.addListener('onWrite', ({ device, value }) => this.handleFrame(device, value)),
      Peripheral.addListener('onError', ({ message }) => events.onLog(message.toUpperCase(), 'error'))
    );

    const profile: Profile = { h: me.handle, n: me.nodeId, k: me.publicKey };
    await Peripheral.start(
      SERVICE_UUID,
      INBOX_UUID,
      PROFILE_UUID,
      Buffer.from(JSON.stringify(profile)).toString('base64'),
      me.handle.slice(0, 8)
    );
    events.onLog(`BEACON ACTIVE :: BROADCASTING AS ${me.handle}`);

    this.manager.startDeviceScan([SERVICE_UUID], { allowDuplicates: true }, (error, device) => {
      if (error) {
        events.onLog(`SCAN ERROR: ${error.message}`, 'error');
        return;
      }
      if (device) this.onDeviceSeen(device);
    });
    events.onLog('SWEEPING 2.4GHZ BAND FOR NODES...');
  }

  stop() {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    this.disconnectSubs.forEach((s) => s.remove());
    this.disconnectSubs.clear();
    try {
      Peripheral?.stop();
    } catch {}
    if (this.manager) {
      this.manager.stopDeviceScan().catch(() => {});
      for (const id of this.connected.keys()) this.manager.cancelDeviceConnection(id).catch(() => {});
      this.manager.destroy().catch(() => {});
      this.manager = null;
    }
    this.connected.clear();
  }

  async send(to: { nodeId: string; publicKey: string }, inner: Inner) {
    const deviceId = this.nodeToDevice.get(to.nodeId);
    if (!deviceId) throw new Error('Peer not in radio range');

    const { nonce, box } = seal(JSON.stringify(inner), to.publicKey, this.me.secretKey);
    const env: Envelope = { v: 2, k: this.me.publicKey, o: nonce, b: box };

    await this.withLock(deviceId, async () => {
      const device = await this.ensureConnected(deviceId);
      // iOS negotiates MTU itself; Android asked for 185 on connect. Stay under 180 either way.
      const frameSize = Math.min((device.mtu || 23) - 3, 180);
      for (const frame of toFrames(JSON.stringify(env), frameSize)) {
        await this.manager!.writeCharacteristicWithResponseForDevice(
          deviceId,
          SERVICE_UUID,
          INBOX_UUID,
          frame.toString('base64')
        );
      }
    });
  }

  // ---- internals ---------------------------------------------------------

  private onDeviceSeen(device: Device) {
    const known = this.deviceToPeer.get(device.id);
    if (known) {
      const now = Date.now();
      if (now - (this.lastSighting.get(device.id) ?? 0) < SIGHTING_THROTTLE_MS) return;
      this.lastSighting.set(device.id, now);
      this.ev.onPeer({ ...known, rssi: device.rssi });
      return;
    }
    if (this.probing.has(device.id)) return;
    if (Date.now() - (this.probeFailedAt.get(device.id) ?? 0) < PROBE_RETRY_MS) return;
    this.probe(device);
  }

  /** Connect once to read who this device is. */
  private async probe(device: Device) {
    this.probing.add(device.id);
    this.ev.onLog(`HANDSHAKE >> ${device.id.slice(-8)}`);
    try {
      const profile = await this.withLock(device.id, async () => {
        await this.ensureConnected(device.id);
        const ch = await this.manager!.readCharacteristicForDevice(device.id, SERVICE_UUID, PROFILE_UUID);
        return JSON.parse(Buffer.from(ch.value ?? '', 'base64').toString('utf8')) as Profile;
      });
      if (!isValidPublicKey(profile?.k) || typeof profile.h !== 'string') throw new Error('bad profile');
      // The node id must match the key, or someone is trying to pass as another node.
      if (profile.n !== nodeIdFor(profile.k)) throw new Error('forged identity');
      if (profile.n === this.me.nodeId) return;

      const handle = profile.h.toUpperCase().replace(/[^A-Z0-9_\-.]/g, '').slice(0, 12) || '?';
      const peer: PeerSighting = { nodeId: profile.n, handle, publicKey: profile.k, rssi: device.rssi };
      // Android rotates its MAC address, so the same node can show up under a new device id.
      const oldDevice = this.nodeToDevice.get(peer.nodeId);
      if (oldDevice && oldDevice !== device.id) this.deviceToPeer.delete(oldDevice);
      this.deviceToPeer.set(device.id, peer);
      this.nodeToDevice.set(peer.nodeId, device.id);
      this.ev.onLog(`NODE IDENTIFIED: ${peer.handle} [${peer.nodeId}]`);
      this.ev.onPeer(peer);
    } catch (e: any) {
      this.probeFailedAt.set(device.id, Date.now());
      this.ev.onLog(`HANDSHAKE FAILED ${device.id.slice(-8)}: ${e?.message ?? e}`, 'warn');
    } finally {
      this.probing.delete(device.id);
    }
  }

  private async ensureConnected(deviceId: string): Promise<Device> {
    const existing = this.connected.get(deviceId);
    if (existing) return existing;
    const m = this.manager;
    if (!m) throw new Error('Radio offline');
    let device = await m.connectToDevice(deviceId, { requestMTU: 185, timeout: 10_000 });
    device = await device.discoverAllServicesAndCharacteristics();
    this.connected.set(deviceId, device);
    this.disconnectSubs.get(deviceId)?.remove();
    this.disconnectSubs.set(
      deviceId,
      m.onDeviceDisconnected(deviceId, () => {
        this.connected.delete(deviceId);
        this.disconnectSubs.get(deviceId)?.remove();
        this.disconnectSubs.delete(deviceId);
      })
    );
    return device;
  }

  /** Serialises GATT operations per device; BLE stacks hate concurrent ones. */
  private withLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(deviceId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(deviceId, next);
    return next;
  }

  private handleFrame(device: string, valueB64: string) {
    const payload = this.reassembler.push(device, Buffer.from(valueB64, 'base64'));
    if (!payload) return;
    try {
      const env = JSON.parse(payload) as Envelope;
      if (env.v !== 2 || !isValidPublicKey(env.k)) throw new Error('bad envelope');
      const json = open(env.b, env.o, env.k, this.me.secretKey);
      if (json == null) {
        // Forged, tampered with, or not meant for us.
        this.ev.onLog('UNAUTHENTICATED PACKET REJECTED', 'error');
        return;
      }
      this.ev.onPacket({ from: { nodeId: nodeIdFor(env.k), publicKey: env.k }, inner: JSON.parse(json) as Inner });
    } catch {
      this.ev.onLog('CORRUPT PACKET DROPPED', 'warn');
    }
  }
}
