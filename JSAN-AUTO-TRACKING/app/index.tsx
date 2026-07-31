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
    // No timezone gate. The server resolves the zone from the driver's own coordinates on the
    // first location it receives, so asking them to pick one from a list was both an extra
    // step before they could start work and less accurate than the answer we can derive.
    return <Redirect href="/home" />;
  }
  return <Redirect href="/login" />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
