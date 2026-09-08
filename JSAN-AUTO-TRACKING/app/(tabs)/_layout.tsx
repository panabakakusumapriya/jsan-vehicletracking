import { Tabs } from 'expo-router';
import { TabBar } from '@/src/components/TabBar';

/**
 * The driver tab group — the conventional Expo Router `(tabs)` structure.
 *
 * The parentheses make this a route GROUP: it organizes home/map under one tab navigator
 * WITHOUT adding a URL segment, so the routes stay `/home` and `/map` and every existing
 * `router.replace('/home' | '/map')` keeps working unchanged.
 *
 * We hand `<Tabs>` our own `<TabBar>` via the `tabBar` prop rather than using the default
 * native bar, because which tabs a driver sees is decided at runtime by the project's
 * `enabledModules` (and the bar must hide itself when only one tab is enabled). TabBar already
 * owns that filtering and the active-route logic; this layout just mounts it once for the group,
 * so the screens no longer render it themselves.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={() => <TabBar />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="map" />
    </Tabs>
  );
}
