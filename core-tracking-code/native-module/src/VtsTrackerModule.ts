import { NativeModule, requireNativeModule } from 'expo';

import { VtsTrackerModuleEvents } from './VtsTracker.types';

declare class VtsTrackerModule extends NativeModule<VtsTrackerModuleEvents> {
  /** Start the native foreground recorder for a trip. */
  start(url: string, token: string, sessionId: string, title: string, text: string): Promise<void>;
  /** Stop recording (flushes remaining queued points first). */
  stop(): Promise<void>;
  /** Nudge an immediate upload of the on-device queue. */
  sync(): Promise<void>;
  /** Engine state. */
  getState(): Promise<{ enabled: boolean }>;
  /** Number of points still queued on-device (not yet acked by the server). */
  getPendingCount(): Promise<number>;
  /** Arm Activity-Recognition auto mode: start/stop trips automatically on driving, surviving
   *  app kill. baseUrl = API root (e.g. https://…/api); token = auth token. */
  enableAutoStart(baseUrl: string, token: string): Promise<boolean>;
  /** Disarm auto mode. */
  disableAutoStart(): Promise<boolean>;
}

export default requireNativeModule<VtsTrackerModule>('VtsTracker');
