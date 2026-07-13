import { router, usePathname } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const C = {
  brand:  '#7c3aed',
  bg:     '#ffffff',
  border: '#e9ecf0',
  muted:  '#9ca3af',
};

const TABS = [
  { path: '/home', label: 'Dashboard', icon: '⚡' },
  { path: '/map',  label: 'My Route',  icon: '🗺️' },
];

export function TabBar() {
  const pathname = usePathname();
  return (
    <View style={s.bar}>
      {TABS.map(tab => {
        const active = pathname === tab.path;
        return (
          <TouchableOpacity
            key={tab.path}
            style={s.tab}
            onPress={() => { if (!active) router.replace(tab.path as any); }}
            activeOpacity={0.7}
          >
            {active && <View style={s.indicator} />}
            <Text style={s.icon}>{tab.icon}</Text>
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
  icon:        { fontSize: 20 },
  label:       { fontSize: 11, fontWeight: '600', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
  labelActive: { color: C.brand },
  indicator:   { position: 'absolute', top: 0, left: '25%', right: '25%', height: 3, borderRadius: 2, backgroundColor: C.brand },
});
