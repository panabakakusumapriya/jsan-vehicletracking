// Shared "tracking reliability" checklist logic — one source of truth for BOTH the homepage health
// card and the first-trip checklist modal. Each item detects a common background-kill cause on Android
// (MIUI/Oppo/Vivo/Huawei battery management) and one-taps the fix, so killed-app tracking survives.
import {
  requestIgnoreBatteryOptimizations,
  openAutostartSettings,
  openAppDetailsSettings,
  openDataUsageSettings,
  openExactAlarmSettings,
  type ReliabilityStatus,
} from './bgGeo';

const AUTOSTART_OEMS = ['xiaomi', 'redmi', 'poco', 'oppo', 'realme', 'vivo', 'iqoo', 'huawei', 'honor', 'oneplus', 'tecno', 'infinix', 'letv'];

export type ReliabilityItem = {
  key: string;
  title: string;
  desc: string;
  problem: boolean;     // true = needs attention
  canVerify: boolean;   // false = we can't read the state (autostart) → "Open to check"
  fix: () => Promise<void>;
};

export function buildReliabilityItems(status: ReliabilityStatus | null): ReliabilityItem[] {
  if (!status) return [];
  const oem = (status.manufacturer || '').toLowerCase();
  const showAutostart = AUTOSTART_OEMS.some((m) => oem.includes(m));
  return [
    { key: 'battery', title: 'Battery optimization', desc: 'Exempt the app so Android can’t freeze tracking in the background.',
      problem: status.batteryOptimized, canVerify: true, fix: async () => { await requestIgnoreBatteryOptimizations(); } },
    ...(showAutostart ? [{
      key: 'autostart', title: 'Autostart / background start', desc: `Allow the app to start in the background (required on ${status.manufacturer}).`,
      problem: true, canVerify: false, fix: async () => { await openAutostartSettings(); } } as ReliabilityItem] : []),
    { key: 'power', title: 'Power-saving mode', desc: 'Power saver throttles background GPS. Turn it off while on shift.',
      problem: status.powerSaveMode, canVerify: true, fix: async () => { await openAppDetailsSettings(); } },
    { key: 'bgdata', title: 'Unrestricted background data', desc: 'Let the app upload points in the background.',
      problem: status.backgroundDataRestricted, canVerify: true, fix: async () => { await openDataUsageSettings(); } },
    { key: 'bgloc', title: 'Background location', desc: 'Set location permission to “Allow all the time”.',
      problem: status.backgroundLocationMissing, canVerify: true, fix: async () => { await openAppDetailsSettings(); } },
    { key: 'alarm', title: 'Exact alarms', desc: 'Lets the self-restart watchdog fire precisely if the service is killed.',
      problem: status.exactAlarmBlocked, canVerify: true, fix: async () => { await openExactAlarmSettings(); } },
  ];
}

/** Count of fixable problems we can actually verify (drives the warning banner). */
export function countProblems(items: ReliabilityItem[]): number {
  return items.filter((i) => i.problem && i.canVerify).length;
}
