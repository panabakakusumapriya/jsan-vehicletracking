import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/src/lib/auth';
import { getFullTrackingHealth, isAllTrackingHealthOk } from '@/src/lib/permissions';
import { TrackingChecklist } from './TrackingChecklist';

/**
 * The POST-login half of the permission hard gate.
 *
 * The launch gate (app/_layout.tsx) guarantees a driver starts six-for-six — but Android can
 * take any of it back mid-session: a revoked permission, an OEM "optimiser" re-restricting
 * battery overnight, the GPS master switch flipped off. The checklist card shows it; this
 * component ENFORCES it: while any of the six is red for a signed-in driver, a blocking
 * overlay covers the app until it is fixed. A driver who cannot be tracked must know it
 * before driving an untracked shift, not after.
 *
 * Re-audited on foreground focus and every 60 s. Renders nothing until the first audit
 * answers, so it can never flash on startup.
 */
export function TrackingGuard() {
  const { user, token } = useAuth();
  const [broken, setBroken] = useState<boolean | null>(null);

  const audit = useCallback(async () => {
    try {
      const h = await getFullTrackingHealth();
      setBroken(!isAllTrackingHealthOk(h));
    } catch { /* keep last verdict — never block on an audit error */ }
  }, []);

  const isDriver = Platform.OS === 'android' && !!token && user?.role === 'user';

  useEffect(() => {
    if (!isDriver) return;
    audit();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') audit(); });
    const t = setInterval(audit, 60_000);
    return () => { sub.remove(); clearInterval(t); };
  }, [isDriver, audit]);

  if (!isDriver || broken !== true) return null;

  return (
    <View style={g.overlay} pointerEvents="auto">
      <View style={g.card}>
        <Text style={g.title}>Tracking is not fully enabled</Text>
        <Text style={g.body}>
          A required permission or setting was turned off. Trips cannot be recorded until every
          item below is green.
        </Text>
        <TrackingChecklist />
      </View>
    </View>
  );
}

const g = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    zIndex: 9999,
    elevation: 9999,
  },
  card: {
    width: '100%',
    backgroundColor: '#f8f7ff',
    borderRadius: 20,
    padding: 18,
    gap: 10,
  },
  title: { fontSize: 17, fontWeight: '900', color: '#dc2626' },
  body:  { fontSize: 13, color: '#374151', lineHeight: 19, marginBottom: 4 },
});
