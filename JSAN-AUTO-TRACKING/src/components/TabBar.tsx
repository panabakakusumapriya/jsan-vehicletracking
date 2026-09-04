import { router, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';

import { useAuth } from '@/src/lib/auth';

const C = {
  brand:  '#7c3aed',
  bg:     '#ffffff',
  border: '#e9ecf0',
  muted:  '#9ca3af',
};

// Icons are FontAwesome (bundled with Expo via @expo/vector-icons) rather than emoji: emoji
// render differently per OEM keyboard/font and cannot take the active tint. Which tabs a
// driver actually sees is the project's call — enabledModules, filtered below.
const ALL_TABS = [
  { path: '/home', label: 'Dashboard', icon: 'tachometer' as const, module: 'dashboard' },
  { path: '/map',  label: 'My Map',    icon: 'map' as const,        module: 'map'       },
];

export function TabBar() {
  const pathname = usePathname();
  const { user } = useAuth();

  // Filter tabs based on project's enabledModules
  const enabled = user?.enabledModules;
  const tabs = (Array.isArray(enabled) && enabled.length > 0)
    ? ALL_TABS.filter(t => enabled.includes(t.module))
    : ALL_TABS;

  // If current screen is not in the allowed tabs, redirect to the first allowed tab
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some(t => t.path === pathname)) {
      router.replace(tabs[0].path as any);
    }
  }, [tabs, pathname]);

  // Only 1 tab — no need to show tab bar, but the redirect above handles navigation
  if (tabs.length <= 1) return null;

  return (
    <View style={s.bar}>
      {tabs.map(tab => {
        const active = pathname === tab.path;
        return (
          <TouchableOpacity
            key={tab.path}
            style={s.tab}
            onPress={() => { if (!active) router.replace(tab.path as any); }}
            activeOpacity={0.7}
          >
            {active && <View style={s.indicator} />}
            <FontAwesome name={tab.icon} size={19} color={active ? C.brand : C.muted} />
            <Text style={[s.label, active && s.labelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: C.bg,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingBottom: 20,
    paddingTop: 8,
  },
  tab:         { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 4 },
  label:       { fontSize: 11, fontWeight: '600', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
  labelActive: { color: C.brand },
  indicator:   { position: 'absolute', top: 0, left: '25%', right: '25%', height: 3, borderRadius: 2, backgroundColor: C.brand },
});
