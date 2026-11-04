import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * A bottom sheet that slides up over the screen, for detail that would otherwise make a page long
 * (the day's working hours). Drag the handle down, or tap outside, to close.
 *
 * Built like BottomSheet.tsx on the platform's own Modal, PanResponder and Animated — no gesture
 * library, no GestureHandlerRootView to forget — so it also ships in an over-the-air update.
 * Only the handle drags; the body scrolls on its own.
 */
const SNAP = { damping: 26, stiffness: 300, mass: 0.6 };

export function ModalSheet({
  visible,
  onClose,
  children,
  heightRatio = 0.86,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Share of the screen the open sheet takes. */
  heightRatio?: number;
}) {
  const insets = useSafeAreaInsets();
  const height = Math.round(Dimensions.get('window').height * heightRatio);
  const [mounted, setMounted] = useState(visible);
  const y = useRef(new Animated.Value(height)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      closing.current = false;
      y.setValue(height);
      Animated.parallel([
        Animated.spring(y, { toValue: 0, ...SNAP, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(y, { toValue: height, duration: 200, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    onClose();
  };

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
    onPanResponderMove: (_e, g) => y.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (g.dy > height * 0.25 || g.vy > 1.1) close();
      else Animated.spring(y, { toValue: 0, ...SNAP, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(y, { toValue: 0, ...SNAP, useNativeDriver: true }).start(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [height]);

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" onRequestClose={close} statusBarTranslucent>
      <Animated.View style={[s.backdrop, { opacity: fade }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View style={[s.sheet, { height, paddingBottom: insets.bottom + 8, transform: [{ translateY: y }] }]}>
        <View {...pan.panHandlers} style={s.handleArea} accessibilityLabel="Drag down to close">
          <View style={s.handle} />
        </View>
        <View style={{ flex: 1 }}>{children}</View>
      </Animated.View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(13,13,18,0.45)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#ffffff', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 16,
  },
  handleArea: { alignItems: 'center', paddingTop: 10, paddingBottom: 8 },
  handle: { width: 42, height: 5, borderRadius: 3, backgroundColor: '#d1d5db' },
});
