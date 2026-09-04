import { forwardRef } from 'react';
import Constants from 'expo-constants';
import { StyleSheet, Text, View } from 'react-native';
import type { MapGLHandle, MapGLProps } from './mapTypes';

/**
 * DriverMap — the driver map's engine selector.
 *
 * Real builds load @maplibre/maplibre-react-native (native MapLibre). Expo Go cannot load
 * that native module, so it gets a plain notice instead of a crash: the map needs a
 * development build (`npx expo run:android`), and the rest of the app keeps working.
 *
 * The native path is require()d lazily and guarded: bundling it is fine everywhere, but
 * EVALUATING it in an environment without the native module throws — that throw must select
 * the notice, never take the screen down.
 */

const isExpoGo = Constants.appOwnership === 'expo';

type MapComponent = React.ForwardRefExoticComponent<
  MapGLProps & React.RefAttributes<MapGLHandle>
>;

let NativeImpl: MapComponent | null = null;
if (!isExpoGo) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    NativeImpl = require('./MapNative').MapNative as MapComponent;
  } catch {
    NativeImpl = null; // a binary built before the maplibre module — same notice as Expo Go
  }
}

const Unavailable = forwardRef<MapGLHandle, MapGLProps>(function Unavailable(_props, _ref) {
  return (
    <View style={u.wrap}>
      <Text style={u.title}>Map needs a development build</Text>
      <Text style={u.body}>
        The map runs on native MapLibre, which {isExpoGo ? 'Expo Go' : 'this build'} does not
        include. Build and install the app with{' '}
        <Text style={u.code}>npx expo run:android</Text> (or an EAS build) to see the map.
        Tracking and everything else keep working.
      </Text>
    </View>
  );
});

export const DriverMap = forwardRef<MapGLHandle, MapGLProps>(function DriverMap(props, ref) {
  const Impl = NativeImpl ?? Unavailable;
  return <Impl {...props} ref={ref} />;
});

const u = StyleSheet.create({
  wrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 28, backgroundColor: '#f7f7fb',
  },
  title: { fontSize: 16, fontWeight: '800', color: '#0d0d12', marginBottom: 8 },
  body:  { fontSize: 13, lineHeight: 19, color: '#6b7280', textAlign: 'center' },
  code:  { fontFamily: 'monospace', color: '#0d0d12' },
});
