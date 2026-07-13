import { useLocalSearchParams } from 'expo-router';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const C = {
  brand: '#7c3aed',
  brandDark: '#5b21b6',
  brandLight: '#f5f3ff',
  bg: '#f8f7ff',
  text: '#0f172a',
  muted: '#64748b',
  muted2: '#94a3b8',
  white: '#ffffff',
  amber: '#d97706',
  amberBg: '#fffbeb',
  line: '#e2e8f0',
};

export default function UpdateScreen() {
  const { newVersion, downloadUrl, releaseNotes, currentVersion } =
    useLocalSearchParams<{ newVersion: string; downloadUrl: string; releaseNotes: string; currentVersion: string }>();

  const hasLink = !!downloadUrl;

  return (
    <View style={s.root}>
      {/* Card */}
      <View style={s.card}>
        <View style={s.iconWrap}>
          <Text style={s.iconEmoji}>🚛</Text>
        </View>

        <Text style={s.title}>Update Required</Text>
        <Text style={s.body}>
          A newer version of JSAN Fleet is required to continue.{'\n'}
          Please update the app to keep tracking.
        </Text>

        {/* Version row */}
        <View style={s.versionRow}>
          <View style={s.versionChip}>
            <Text style={s.versionLabel}>Current</Text>
            <Text style={s.versionValue}>v{currentVersion || '—'}</Text>
          </View>
          <View style={s.arrow}>
            <Text style={s.arrowText}>→</Text>
          </View>
          <View style={[s.versionChip, s.versionChipNew]}>
            <Text style={[s.versionLabel, { color: C.brand }]}>Required</Text>
            <Text style={[s.versionValue, { color: C.brand }]}>v{newVersion || '—'}</Text>
          </View>
        </View>

        {/* Release notes */}
        {!!releaseNotes && (
          <View style={s.notesBox}>
            <Text style={s.notesTitle}>What's new</Text>
            <Text style={s.notesText}>{releaseNotes}</Text>
          </View>
        )}
      </View>

      {/* Download button */}
      {hasLink ? (
        <TouchableOpacity
          style={s.btn}
          activeOpacity={0.85}
          onPress={() => Linking.openURL(downloadUrl)}
        >
          <Text style={s.btnText}>Download update →</Text>
        </TouchableOpacity>
      ) : (
        <View style={s.btnDisabled}>
          <Text style={s.btnDisabledText}>Download link not available yet</Text>
        </View>
      )}

      <Text style={s.hint}>Contact your fleet manager if you need help updating.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: C.white,
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 6,
    marginBottom: 16,
  },
  iconWrap: {
    width: 76,
    height: 76,
    borderRadius: 22,
    backgroundColor: C.brandLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
    borderWidth: 1.5,
    borderColor: 'rgba(124,58,237,0.15)',
  },
  iconEmoji: { fontSize: 36 },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: C.text,
    marginBottom: 10,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: C.muted,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 20,
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 20,
  },
  versionChip: {
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: C.line,
  },
  versionChipNew: {
    backgroundColor: C.brandLight,
    borderColor: 'rgba(124,58,237,0.2)',
  },
  versionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: C.muted2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  versionValue: {
    fontSize: 17,
    fontWeight: '800',
    color: C.text,
    fontVariant: ['tabular-nums'],
  },
  arrow: { paddingHorizontal: 2 },
  arrowText: { fontSize: 20, color: C.muted2 },
  notesBox: {
    width: '100%',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: C.line,
  },
  notesTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  notesText: {
    fontSize: 13.5,
    color: C.text,
    lineHeight: 20,
  },
  btn: {
    width: '100%',
    backgroundColor: C.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
    shadowColor: C.brand,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  btnText: {
    color: C.white,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  btnDisabled: {
    width: '100%',
    backgroundColor: '#f1f5f9',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.line,
  },
  btnDisabledText: {
    color: C.muted,
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    fontSize: 12,
    color: C.muted2,
    textAlign: 'center',
  },
});
