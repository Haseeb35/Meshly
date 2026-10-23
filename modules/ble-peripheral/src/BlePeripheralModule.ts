import { NativeModule, requireOptionalNativeModule } from 'expo';

export type WriteEvent = { device: string; value: string };
export type ErrorEvent = { message: string };

type Events = {
  onWrite(event: WriteEvent): void;
  onError(event: ErrorEvent): void;
};

declare class BlePeripheralModule extends NativeModule<Events> {
  /** Opens the GATT server and starts advertising. Values are base64. */
  start(
    serviceUuid: string,
    inboxUuid: string,
    profileUuid: string,
    profileB64: string,
    localName: string
  ): Promise<void>;
  setProfile(profileB64: string): void;
  stop(): void;
}

// Null in Expo Go / web, where the app falls back to demo mode.
export default requireOptionalNativeModule<BlePeripheralModule>('BlePeripheral');
