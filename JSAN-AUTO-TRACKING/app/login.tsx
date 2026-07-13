import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '@/src/lib/auth';

// Brand palette
const C = {
  brand:     '#7c3aed',
  brandDeep: '#5b21b6',
  brandSoft: '#ede9fe',
  brandMid:  '#a78bfa',
  bg:        '#f7f7fb',
  surface:   '#ffffff',
  border:    '#ede9fe',
  borderMid: '#e5e7eb',
  text:      '#0d0d12',
  textSub:   '#374151',
  muted:     '#9ca3af',
  red:       '#dc2626',
  redBg:     '#fef2f2',
};

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('driver@jsan.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null); setBusy(true);
    try {
      const user = await signIn(email.trim(), password);
      if (user.role !== 'user') {
        setError('This app is for drivers only. Admins/managers use the web panel.');
        return;
      }
      router.replace('/home');
    } catch (e: any) {
      setError(e?.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={s.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Top brand block */}
        <View style={s.hero}>
          {/* Decorative circle behind logo */}
          <View style={s.heroBg} />
          <View style={s.logoRing}>
            <View style={s.logoBox}>
              <Text style={s.logoEmoji}>🚛</Text>
            </View>
          </View>
          <Text style={s.appName}>JSANFleet</Text>
          <View style={s.tagRow}>
            <View style={s.tagDot} />
            <Text style={s.tagText}>DRIVER PORTAL</Text>
          </View>
        </View>

        {/* Form */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Welcome back</Text>
          <Text style={s.cardSub}>Sign in to start your shift</Text>

          <View style={s.sep} />

          {/* Email */}
          <View style={s.field}>
            <Text style={s.label}>Email address</Text>
            <View style={[s.inputWrap, focused === 'email' && s.inputWrapFocused]}>
              <Text style={[s.inputIcon, focused === 'email' && s.inputIconFocused]}>✉</Text>
              <TextInput
                style={s.input}
                placeholder="driver@company.com"
                placeholderTextColor={C.muted}
                autoCapitalize="none"
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
                onFocus={() => setFocused('email')}
                onBlur={() => setFocused(null)}
              />
            </View>
          </View>

          {/* Password */}
          <View style={s.field}>
            <Text style={s.label}>Password</Text>
            <View style={[s.inputWrap, focused === 'password' && s.inputWrapFocused]}>
              <Text style={[s.inputIcon, focused === 'password' && s.inputIconFocused]}>🔒</Text>
              <TextInput
                style={s.input}
                placeholder="••••••••"
                placeholderTextColor={C.muted}
                secureTextEntry
                value={password}
                onChangeText={setPassword}
                onFocus={() => setFocused('password')}
                onBlur={() => setFocused(null)}
              />
            </View>
          </View>

          {error ? (
            <View style={s.errorBox}>
              <Text style={s.errorText}>⚠  {error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[s.btn, busy && s.btnDisabled]}
            onPress={onSubmit}
            disabled={busy}
            activeOpacity={0.88}
          >
            {busy
              ? <ActivityIndicator color="#fff" />
              : <Text style={s.btnText}>Sign In  →</Text>
            }
          </TouchableOpacity>
        </View>

        <Text style={s.foot}>
          Tracking runs automatically in the background
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root:  { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 52, gap: 18 },

  /* Hero */
  hero:   { alignItems: 'center', gap: 10, paddingVertical: 4 },
  heroBg: {
    position: 'absolute', top: -30,
    width: 220, height: 220, borderRadius: 110,
    backgroundColor: 'rgba(124,58,237,0.07)',
  },
  logoRing: {
    width: 88, height: 88, borderRadius: 28,
    backgroundColor: C.brandSoft,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 2,
  },
  logoBox: {
    width: 72, height: 72, borderRadius: 22,
    backgroundColor: C.brand,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.brand,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35, shadowRadius: 16, elevation: 10,
  },
  logoEmoji: { fontSize: 30 },
  appName:   { color: C.text, fontSize: 30, fontWeight: '900', letterSpacing: -0.8 },
  tagRow:    { flexDirection: 'row', alignItems: 'center', gap: 7 },
  tagDot:    { width: 6, height: 6, borderRadius: 3, backgroundColor: C.brandMid },
  tagText:   { color: C.brandMid, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },

  /* Card */
  card: {
    backgroundColor: C.surface,
    borderRadius: 22, borderWidth: 1, borderColor: C.borderMid,
    padding: 26,
    shadowColor: '#111', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 14, elevation: 3,
  },
  cardTitle: { color: C.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.4 },
  cardSub:   { color: C.muted, fontSize: 13.5, marginTop: 4 },
  sep:       { height: 1, backgroundColor: C.borderMid, marginVertical: 20 },

  /* Fields */
  field:  { marginBottom: 16 },
  label:  { color: C.textSub, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#f9fafb', borderRadius: 12,
    borderWidth: 1.5, borderColor: C.borderMid,
  },
  inputWrapFocused: { borderColor: C.brand, backgroundColor: '#fff' },
  inputIcon:        { paddingLeft: 14, fontSize: 14, color: C.muted },
  inputIconFocused: { color: C.brand },
  input: {
    flex: 1, paddingHorizontal: 12, paddingVertical: 14,
    fontSize: 15, color: C.text,
  },

  /* Error */
  errorBox: {
    backgroundColor: C.redBg, borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.2)',
    borderRadius: 10, padding: 12, marginBottom: 14,
  },
  errorText: { color: C.red, fontSize: 13, fontWeight: '500', lineHeight: 18 },

  /* Button */
  btn: {
    marginTop: 6, borderRadius: 13, paddingVertical: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.brand,
    shadowColor: C.brandDeep,
    shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 14, elevation: 7,
  },
  btnDisabled: { opacity: 0.5 },
  btnText:     { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },

  foot: { color: C.muted, fontSize: 12, textAlign: 'center', lineHeight: 18, paddingBottom: 8 },
});
