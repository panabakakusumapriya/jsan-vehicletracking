import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useAuth } from '@/src/lib/auth';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('driver@jsan.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setBusy(true);
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
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        {/* Logo / Brand */}
        <View style={styles.logoWrap}>
          <View style={styles.logoBox}>
            <Text style={styles.logoText}>🚗</Text>
          </View>
          <Text style={styles.brand}>JSANFleet</Text>
          <Text style={styles.tagline}>Driver Tracking</Text>
        </View>

        {/* Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Welcome back</Text>
          <Text style={styles.cardSub}>Sign in to start your shift</Text>

          <View style={styles.fieldWrap}>
            <Text style={styles.label}>Email address</Text>
            <TextInput
              style={[styles.input, focusedField === 'email' && styles.inputFocused]}
              placeholder="driver@company.com"
              placeholderTextColor="#5a6478"
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              onFocus={() => setFocusedField('email')}
              onBlur={() => setFocusedField(null)}
            />
          </View>

          <View style={styles.fieldWrap}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={[styles.input, focusedField === 'password' && styles.inputFocused]}
              placeholder="••••••••"
              placeholderTextColor="#5a6478"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              onFocus={() => setFocusedField('password')}
              onBlur={() => setFocusedField(null)}
            />
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠ {error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={onSubmit}
            disabled={busy}
            activeOpacity={0.85}
          >
            {busy
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>Sign In →</Text>
            }
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>Tracking runs automatically in the background</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080e1a',
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 24,
  },
  logoWrap: {
    alignItems: 'center',
    gap: 6,
  },
  logoBox: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: '#162035',
    borderWidth: 1,
    borderColor: '#1e2d45',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  logoText: {
    fontSize: 30,
  },
  brand: {
    color: '#e8eef8',
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  tagline: {
    color: '#5a9eff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: '#0f1827',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1e2d45',
    padding: 24,
    gap: 0,
  },
  cardTitle: {
    color: '#e8eef8',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 4,
  },
  cardSub: {
    color: '#7a8699',
    fontSize: 14,
    marginBottom: 22,
  },
  fieldWrap: {
    marginBottom: 14,
  },
  label: {
    color: '#c4cede',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 7,
  },
  input: {
    backgroundColor: '#162035',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#253452',
    color: '#e8eef8',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
  },
  inputFocused: {
    borderColor: '#2f7bff',
    backgroundColor: '#1a2640',
  },
  errorBox: {
    backgroundColor: 'rgba(255,82,82,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,82,82,0.25)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  errorText: {
    color: '#ff5252',
    fontSize: 13,
    lineHeight: 18,
  },
  button: {
    backgroundColor: '#2f7bff',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 6,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  footer: {
    color: '#3d4a5e',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
});
