/**
 * PAYROLL-CRITICAL: OEM killer app detection.
 *
 * Some Android OEMs aggressively kill background services regardless of
 * permissions granted. Drivers on these devices WILL lose tracking data
 * unless they manually whitelist the app in OEM-specific settings.
 *
 * This service identifies such devices and returns actionable guidance.
 *
 * References:
 *   - dontkillmyapp.com (canonical list)
 *   - Our real-world incidents
 */

import * as Device from 'expo-device';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

export interface OEMWarning {
  brand: string;
  severity: 'extreme' | 'high' | 'medium';
  title: string;
  instructions: string[];
  intentActions?: string[]; // Android settings intent actions to try
}

const OEM_DATABASE: Record<string, OEMWarning> = {
  xiaomi: {
    brand: 'Xiaomi/MIUI',
    severity: 'extreme',
    title: 'Xiaomi / Redmi / POCO devices aggressively kill background apps',
    instructions: [
      '1. Open Settings → Apps → Manage apps → JSAN VTS',
      '2. Tap "Battery saver" → select "No restrictions"',
      '3. Tap "Autostart" → turn ON',
      '4. Settings → Apps → Permissions → Autostart → enable for JSAN VTS',
      '5. Long-press JSAN VTS in recent apps → lock icon to prevent killing',
      '6. Settings → Battery & performance → App battery saver → JSAN VTS → "No restrictions"'
    ],
    intentActions: [
      'miui.intent.action.APP_PERM_EDITOR',
      'android.settings.APPLICATION_DETAILS_SETTINGS'
    ]
  },
  redmi: { brand: 'Redmi (MIUI)', severity: 'extreme', title: 'Redmi devices kill background apps', instructions: [], intentActions: [] },
  poco: { brand: 'POCO (MIUI)', severity: 'extreme', title: 'POCO devices kill background apps', instructions: [], intentActions: [] },
  oppo: {
    brand: 'OPPO/ColorOS',
    severity: 'extreme',
    title: 'OPPO devices aggressively kill background apps',
    instructions: [
      '1. Settings → Battery → JSAN VTS → Allow background activity',
      '2. Settings → Apps → JSAN VTS → Battery usage → Don\'t optimize',
      '3. Settings → Privacy permissions → Startup manager → enable JSAN VTS',
      '4. Lock JSAN VTS in recent apps (swipe down on app tile)'
    ]
  },
  realme: {
    brand: 'Realme/ColorOS',
    severity: 'extreme',
    title: 'Realme devices aggressively kill background apps',
    instructions: [
      '1. Settings → Battery → JSAN VTS → Allow background activity',
      '2. Settings → Apps → JSAN VTS → Battery usage → Don\'t optimize',
      '3. Lock JSAN VTS in recent apps'
    ]
  },
  huawei: {
    brand: 'Huawei/EMUI',
    severity: 'extreme',
    title: 'Huawei devices aggressively kill background apps',
    instructions: [
      '1. Settings → Apps → App launch → JSAN VTS → switch OFF auto-manage',
      '2. Enable Auto-launch, Secondary launch, Run in background',
      '3. Settings → Battery → App launch → JSAN VTS → Manual management (all toggles on)',
      '4. Lock JSAN VTS in recent apps'
    ]
  },
  honor: {
    brand: 'Honor/EMUI',
    severity: 'extreme',
    title: 'Honor devices aggressively kill background apps',
    instructions: [
      '1. Settings → Apps → App launch → JSAN VTS → switch OFF auto-manage, enable all three toggles',
      '2. Lock JSAN VTS in recent apps'
    ]
  },
  vivo: {
    brand: 'Vivo/Funtouch',
    severity: 'extreme',
    title: 'Vivo devices aggressively kill background apps',
    instructions: [
      '1. Settings → Battery → High background power consumption → add JSAN VTS',
      '2. Settings → Apps → JSAN VTS → Autostart → enable',
      '3. Settings → More settings → Permissions → Autostart → enable JSAN VTS',
      '4. Lock JSAN VTS in recent apps'
    ]
  },
  oneplus: {
    brand: 'OnePlus/OxygenOS',
    severity: 'high',
    title: 'OnePlus devices may kill background apps',
    instructions: [
      '1. Settings → Battery → Battery optimization → JSAN VTS → Don\'t optimize',
      '2. Settings → Apps → JSAN VTS → Battery → Allow background activity'
    ]
  },
  samsung: {
    brand: 'Samsung/One UI',
    severity: 'medium',
    title: 'Samsung devices may kill background apps',
    instructions: [
      '1. Settings → Battery & device care → Battery → Background usage limits',
      '2. Remove JSAN VTS from "Sleeping apps" and "Deep sleeping apps"',
      '3. Add JSAN VTS to "Never sleeping apps"',
      '4. Settings → Apps → JSAN VTS → Battery → Unrestricted'
    ]
  },
  asus: {
    brand: 'Asus/ZenUI',
    severity: 'high',
    title: 'Asus devices may kill background apps',
    instructions: [
      '1. Settings → Power management → Auto-start manager → JSAN VTS → Allow',
      '2. Settings → Battery → PowerMaster → JSAN VTS → not protected'
    ]
  }
};

/**
 * Detects the current device OEM and returns compatibility warning (if any).
 * Returns null for iOS, unknown devices, or non-problematic OEMs.
 */
export function detectOEMIssue(): OEMWarning | null {
  if (Platform.OS !== 'android') return null;

  const brand = (Device.brand || '').toLowerCase();
  const manufacturer = (Device.manufacturer || '').toLowerCase();

  const key = Object.keys(OEM_DATABASE).find(k => brand.includes(k) || manufacturer.includes(k));
  if (!key) return null;

  return OEM_DATABASE[key];
}

/**
 * Returns a human-readable device summary for diagnostics / crash reports.
 */
export function getDeviceSummary(): string {
  if (Platform.OS !== 'android') {
    return `${Device.modelName || 'Unknown iOS device'} (iOS ${Device.osVersion})`;
  }
  return `${Device.brand || '?'} ${Device.modelName || '?'} (Android ${Device.osVersion}, ${Device.osBuildId || '?'})`;
}

/**
 * Attempt to open the OEM-specific background app settings screen.
 * Falls back to the generic app-details settings.
 */
export async function openOEMSettings(warning: OEMWarning): Promise<void> {
  if (Platform.OS !== 'android') return;

  const actions = warning.intentActions || ['android.settings.APPLICATION_DETAILS_SETTINGS'];
  for (const action of actions) {
    try {
      await IntentLauncher.startActivityAsync(action);
      return;
    } catch (_) {
      // Try next action
    }
  }

  // Last-resort fallback
  try {
    await IntentLauncher.startActivityAsync('android.settings.SETTINGS');
  } catch (_) {
    // Give up — user will have to navigate manually
  }
}
