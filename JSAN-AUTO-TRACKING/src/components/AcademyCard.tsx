import FontAwesome from '@expo/vector-icons/FontAwesome';
import { router } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { LESSON_COUNT, loadProgress } from '@/src/lib/academy';
import { useAuth } from '@/src/lib/auth';

/** Dashboard entry to the Driver Academy: progress, and a way back in any time. */
export function AcademyCard() {
  const { user } = useAuth();
  if (!user) return null;
  const p = loadProgress(user);
  const done = Math.min(LESSON_COUNT, p.done.length);
  const finished = Boolean(p.completedAt);
  return (
    <TouchableOpacity style={s.card} onPress={() => router.push('/academy' as any)} accessibilityLabel="Open the Driver Academy">
      <View style={s.icon}><FontAwesome name="graduation-cap" size={18} color="#fff" /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.title}>Driver Academy</Text>
        <Text style={s.sub}>
          {finished ? 'Finished · tap to review how the app works' : `${done} of ${LESSON_COUNT} lessons · learn how the app works`}
        </Text>
        <View style={s.track}><View style={[s.fill, { width: `${Math.round((done / LESSON_COUNT) * 100)}%` }]} /></View>
      </View>
      <FontAwesome name={finished ? 'check-circle' : 'chevron-right'} size={finished ? 20 : 14} color={finished ? '#059669' : '#7c3aed'} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#ffffff',
    borderRadius: 16, borderWidth: 1, borderColor: '#e9ecf0', padding: 14,
  },
  icon: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#7c3aed', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14.5, fontWeight: '800', color: '#0d0d12' },
  sub: { fontSize: 12.5, color: '#6b7280', marginTop: 2 },
  track: { height: 5, borderRadius: 99, backgroundColor: '#e5e7eb', marginTop: 8, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 99, backgroundColor: '#059669' },
});
