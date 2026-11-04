import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ModalSheet } from '@/src/components/ModalSheet';
import * as VehicleTracker from '@/modules/vehicle-tracker';
import {
  getFullTrackingHealth,
  isAllTrackingHealthOk,
  requestAllPermissions,
  type FullTrackingHealth,
} from '@/src/lib/permissions';

/**
 * The tracking health checklist — the same six switches the pre-login gate enforces, kept
 * visible on the dashboard so a driver (or the person on the phone with them) can see AT A
 * GLANCE why tracking might be degraded. Permissions get revoked after installs, OEM
 * "optimisers" re-enable battery limits overnight, GPS gets toggled off — the gate catches
 * launch-time state, this catches everything after.
 *
 * Re-checked when the app returns to the foreground (the driver coming back from Settings)
 * and every 30 s while visible.
 *
 * `compact` (the Home screen): one line — all good, or which checks fail with Fix now right there —
 * and the full list in a bottom sheet on tap, so the screen stays short. The tracking gate shows it
 * in full.
 */

type Row = { key: keyof FullTrackingHealth; label: string; minVersion?: number };

const ROWS: Row[] = [
  { key: 'fineLocation',       label: 'Precise location' },
  { key: 'backgroundLocation', label: 'Background location ("all the time")' },
  { key: 'activityRecognition', label: 'Physical activity (auto-restart)', minVersion: 29 },
  { key: 'notifications',      label: 'Notifications', minVersion: 33 },
  { key: 'batteryExempt',      label: 'Battery optimisation off' },
  { key: 'locationServices',   label: 'Location (GPS) switched on' },
];

/** Manufacturer-specific extra steps — the part no permission API can grant for us. */
function oemTip(): string | null {
  if (Platform.OS !== 'android') return null;
  const brand = String((Platform.constants as { Brand?: string } | undefined)?.Brand ?? '').toLowerCase();
  if (brand.includes('xiaomi') || brand.includes('redmi') || brand.includes('poco')) {
    return 'Xiaomi/Redmi: also enable Autostart and set Battery saver → No restrictions for JSAN Fleet.';
  }
  if (brand.includes('oppo') || brand.includes('realme')) {
    return 'Oppo/Realme: also allow Auto-launch and disable App Quick Freeze for JSAN Fleet.';
  }
  if (brand.includes('vivo') || brand.includes('iqoo')) {
    return 'Vivo: also enable Autostart and High background power consumption for JSAN Fleet.';
  }
  if (brand.includes('huawei') || brand.includes('honor')) {
    return 'Huawei/Honor: App launch → Manage manually → enable all three toggles for JSAN Fleet.';
  }
  if (brand.includes('samsung')) {
    return 'Samsung: make sure JSAN Fleet is NOT in "Sleeping apps" (Battery → Background usage limits).';
  }
  return null;
}

export function TrackingChecklist({ compact = false }: { compact?: boolean }) {
  const [health, setHealth] = useState<FullTrackingHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try { setHealth(await getFullTrackingHealth()); } catch { /* next tick retries */ }
  }, []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') refresh(); });
    const t = setInterval(refresh, 30_000);
    return () => { mountedRef.current = false; sub.remove(); clearInterval(t); };
  }, [refresh]);

  const fixAll = useCallback(async () => {
    setBusy(true);
    try {
      await requestAllPermissions();
      const h = await getFullTrackingHealth();
      if (h.batteryExempt === 'denied') {
        try { await VehicleTracker.requestIgnoreBatteryOptimizations(); } catch { /* settings below */ }
      }
      if (h.locationServices === 'denied') {
        // No API can flip the GPS master switch — the settings screen is the honest answer.
        Linking.openSettings();
      }
      await refresh();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [refresh]);

  if (Platform.OS !== 'android' || !health) return null;

  const version = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
  const rows = ROWS.filter((r) => r.minVersion === undefined || version >= r.minVersion);
  const allOk = isAllTrackingHealthOk(health);
  const tip = oemTip();

  const okOf = (r: Row) => health[r.key] === 'granted' || health[r.key] === 'unavailable';
  const failing = rows.filter((r) => !okOf(r));
  const badge = (
    <Text style={[c.badge, allOk ? c.badgeOk : c.badgeBad]}>
      {allOk ? 'ALL GOOD' : 'NEEDS ATTENTION'}
    </Text>
  );
  const buttons = !allOk && (
    <View style={c.btnRow}>
      <TouchableOpacity style={c.fixBtn} onPress={fixAll} disabled={busy}>
        <Text style={c.fixTxt}>{busy ? 'Checking…' : 'Fix now'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={c.setBtn} onPress={() => Linking.openSettings()}>
        <Text style={c.setTxt}>App settings</Text>
      </TouchableOpacity>
    </View>
  );
  const list = (
    <>
      {rows.map((r) => {
        const ok = okOf(r);
        return (
          <View key={r.key} style={c.row}>
            <Text style={[c.mark, ok ? c.markOk : c.markBad]}>{ok ? '✓' : '✕'}</Text>
            <Text style={[c.label, !ok && c.labelBad]} numberOfLines={1}>{r.label}</Text>
          </View>
        );
      })}
      {tip && !allOk && <Text style={c.tip}>{tip}</Text>}
    </>
  );

  if (!compact) {
    return (
      <View style={[c.card, allOk ? c.cardOk : c.cardBad]}>
        <View style={c.head}>
          <Text style={c.title}>Tracking checklist</Text>
          {badge}
        </View>
        {list}
        {buttons}
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity
        style={[c.card, allOk ? c.cardOk : c.cardBad]}
        onPress={() => setOpen(true)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Open tracking checklist"
      >
        <View style={c.head}>
          <Text style={c.title}>Tracking checklist</Text>
          {badge}
        </View>
        <View style={c.summaryRow}>
          <Text style={[c.summary, !allOk && c.labelBad]} numberOfLines={2}>
            {allOk
              ? `All ${rows.length} checks pass — tracking runs in the background`
              : `${failing.length} to fix: ${failing.map((r) => r.label).join(', ')}`}
          </Text>
          <Text style={c.view}>View ›</Text>
        </View>
        {buttons}
      </TouchableOpacity>

      <ModalSheet visible={open} onClose={() => setOpen(false)} heightRatio={0.62}>
        <ScrollView contentContainerStyle={c.sheetBody}>
          <View style={c.head}>
            <Text style={c.sheetTitle}>Tracking checklist</Text>
            {badge}
          </View>
          <Text style={c.sheetSub}>
            Everything the phone needs so trips are recorded on their own, even with the app closed.
          </Text>
          {list}
          {buttons}
        </ScrollView>
      </ModalSheet>
    </>
  );
}

const c = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff', borderRadius: 18, padding: 16,
    borderWidth: 1,
    shadowColor: '#0f172a', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
  },
  cardOk:  { borderColor: '#a7f3d0' },
  cardBad: { borderColor: '#fecaca' },
  head:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  title:   { fontSize: 13.5, fontWeight: '800', color: '#0f172a' },
  badge:   { fontSize: 9.5, fontWeight: '900', letterSpacing: 0.5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, overflow: 'hidden' },
  badgeOk: { color: '#059669', backgroundColor: '#ecfdf5' },
  badgeBad:{ color: '#dc2626', backgroundColor: '#fef2f2' },
  row:     { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3.5 },
  mark:    { fontSize: 12, fontWeight: '900', width: 16, textAlign: 'center' },
  markOk:  { color: '#059669' },
  markBad: { color: '#dc2626' },
  label:   { fontSize: 12.5, color: '#374151', flex: 1 },
  labelBad:{ color: '#0f172a', fontWeight: '700' },
  tip:     { fontSize: 11.5, color: '#b45309', backgroundColor: '#fffbeb', borderRadius: 8, padding: 8, marginTop: 8, lineHeight: 16 },
  btnRow:  { flexDirection: 'row', gap: 8, marginTop: 10 },
  fixBtn:  { flex: 2, backgroundColor: '#7c3aed', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  fixTxt:  { color: '#ffffff', fontSize: 13, fontWeight: '800' },
  setBtn:  { flex: 1, backgroundColor: '#f1f5f9', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  setTxt:  { color: '#475569', fontSize: 13, fontWeight: '700' },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summary: { flex: 1, fontSize: 12.5, color: '#374151' },
  view:    { fontSize: 13, fontWeight: '700', color: '#7c3aed' },
  sheetBody: { paddingHorizontal: 18, paddingBottom: 24 },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  sheetSub: { fontSize: 13, color: '#475569', marginBottom: 10, lineHeight: 18 },
});
