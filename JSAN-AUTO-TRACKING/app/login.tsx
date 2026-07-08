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
      <View style={styles.card}>
        <Text style={styles.brand}>JSAN</Text>
        <Text style={styles.title}>Driver Sign In</Text>
        <Text style={styles.subtitle}>Log in once. Tracking starts automatically when you drive.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#8a94a6"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#8a94a6"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity style={[styles.button, busy && styles.buttonDisabled]} onPress={onSubmit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1220', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#131c2e', borderRadius: 20, padding: 24 },
  brand: { color: '#4da3ff', fontSize: 34, fontWeight: '800', letterSpacing: 2 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 8 },
  subtitle: { color: '#8a94a6', fontSize: 14, marginTop: 6, marginBottom: 20 },
  input: {
    backgroundColor: '#0b1220',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#26324a',
    color: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    marginBottom: 12,
  },
  error: { color: '#ff6b6b', marginBottom: 12 },
  button: {
    backgroundColor: '#2f7bff',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
