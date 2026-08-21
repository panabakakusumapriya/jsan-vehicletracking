import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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

// The real brand mark, 172x56 with transparency. Dark ink, so it belongs on the light background
// rather than on a coloured tile — on the brand purple it was close to unreadable. It is a
// wordmark, so it also replaces the separate "JSANFleet" text that used to sit under it.
const LOGO = require('../assets/images/jsan-logo.png');
const LOGO_W = 196;
const LOGO_H = Math.round((LOGO_W * 56) / 172); // keep the source 3.07:1 ratio exactly

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
  // Starts empty. It used to be pre-filled with a development address, which a real driver saw as
  // someone else's login already sitting in the field.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setError(null); setBusy(true);
    try {
      const user = await signIn(email.trim(), password);
      if (user.role !== 'user') {
        setError('This app is for drivers only. Admins/managers use the web panel.');
        return;
      }
      // If no timezone is set, redirect to timezone setup first
      if (!user.timezone) {
        router.replace('/timezone-setup' as any);
      } else {
        router.replace('/home');
      }
    } catch (e: any) {
      // Someone is already signed in with this account on another device — surface a popup.
      if (e?.code === 'ALREADY_LOGGED_IN') {
        Alert.alert(
          'Already logged in',
          e?.message ?? 'This account is already logged in on another device. Log out there first.',
          [{ text: 'OK' }],
        );
      } else {
        setError(e?.message ?? 'Login failed');
      }
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
          <Image
            source={LOGO}
            style={s.logo}
            contentFit="contain"
            accessibilityLabel="JSAN"
          />
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
                autoCorrect={false}
                keyboardType="email-address"
                // Lets the OS and password managers offer the saved account.
                autoComplete="email"
                textContentType="emailAddress"
                // Move to the password rather than dismissing the keyboard, so signing in is one
                // continuous action instead of tap-type-dismiss-tap-type.
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => passwordRef.current?.focus()}
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
                ref={passwordRef}
                style={s.input}
                placeholder="••••••••"
                placeholderTextColor={C.muted}
                // The whole point of the reveal toggle: drivers type this on a phone, often in a
                // moving vehicle or gloves, and a mistyped password they cannot see is the most
                // common reason a shift fails to start.
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={onSubmit}
                value={password}
                onChangeText={setPassword}
                onFocus={() => setFocused('password')}
                onBlur={() => setFocused(null)}
              />
              <TouchableOpacity
                onPress={() => setShowPassword((v) => !v)}
                style={s.eyeBtn}
                // Generous tap area — the icon itself is well under the 44pt minimum.
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
              >
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={focused === 'password' ? C.brand : C.muted}
                />
              </TouchableOpacity>
            </View>
          </View>

          {error ? (
            <View style={s.errorBox}>
              <Text style={s.errorText}>⚠  {error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[s.btn, !canSubmit && s.btnDisabled]}
            onPress={onSubmit}
            // Disabled until both fields have something, so a blank tap cannot produce a
            // round trip that comes back as a credentials error.
            disabled={!canSubmit}
            activeOpacity={0.88}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit, busy }}
          >
            {busy
              ? <ActivityIndicator color="#fff" />
              : <Text style={s.btnText}>Sign In  →</Text>
            }
          </TouchableOpacity>
        </View>

        <View style={{ paddingBottom: 8 }} />
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
  // Sized from the source ratio so the wordmark is never stretched. No coloured tile behind it:
  // the mark is dark ink on transparency and needs the light background to stay legible.
  logo:      { width: LOGO_W, height: LOGO_H, marginBottom: 6 },
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
  eyeBtn: { paddingHorizontal: 14, paddingVertical: 12 },

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

});
