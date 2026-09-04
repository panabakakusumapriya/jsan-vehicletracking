import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useAuth } from '@/src/lib/auth';

/** Auth gate: sends drivers to /home, everyone else to /login. */
export default function Index() {
  const { loading, token, user } = useAuth();

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Only drivers ('user') use this app; admins/managers use the web panel.
  if (token && user?.role === 'user') {
    const enabled = user.enabledModules;
    if (Array.isArray(enabled) && enabled.length > 0 && !enabled.includes('dashboard') && enabled.includes('map')) {
      return <Redirect href="/map" />;
    }
    return <Redirect href="/home" />;
  }
  return <Redirect href="/login" />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
