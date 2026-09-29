import type { ReactNode } from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

/** What the map screen keeps, so picking a marker or starting a drop can lower the sheet itself. */
export interface BottomSheetHandle {
  expand: () => void;
  collapse: () => void;
}

interface Props {
  /** Height left on screen when collapsed — the strip the driver always sees. */
  peek: number;
  /** Height when fully open. */
  expanded: number;
  /** Always visible inside the collapsed strip. Doubles as the drag handle and the tap target. */
  header: ReactNode;
  children: ReactNode;
}

/** Near-critically damped: arrives with a hint of momentum and no wobble. */
const SNAP = { damping: 26, stiffness: 300, mass: 0.6 };

/**
 * A drag-to-open sheet, by hand.
 *
 * Built on the platform's own PanResponder and Animated rather than a gesture library: this app
 * has no GestureHandlerRootView anywhere, and a sheet that needed one would silently stop taking
 * drags — on the one screen a driver opens while standing at the back of a van — the moment that
 * wiring was missed. PanResponder needs no root view and no babel plugin.
 *
 * Only the header drags. The body is a ScrollView and owns its own vertical gestures, so pulling
 * on a stat card scrolls the list instead of fighting the sheet.
 */
export const BottomSheet = forwardRef<BottomSheetHandle, Props>(function BottomSheet(
  { peek, expanded, header, children }, ref
) {
  const collapsedY = Math.max(0, expanded - peek);
  const [translateY] = useState(() => new Animated.Value(collapsedY));
  const openRef = useRef(false);
  /** Where the current drag began — also where the last settle left the sheet. */
  const dragStartRef = useRef(collapsedY);

  const animateTo = useCallback((to: number) => {
    Animated.spring(translateY, { toValue: to, ...SNAP, useNativeDriver: true })
      .start(({ finished }) => { if (finished) dragStartRef.current = to; });
  }, [translateY]);

  useImperativeHandle(ref, () => ({
    expand: () => { openRef.current = true; animateTo(0); },
    collapse: () => { openRef.current = false; animateTo(collapsedY); },
  }), [animateTo, collapsedY]);

  // A peek that changes under a closed sheet must not leave it floating mid-air.
  useEffect(() => {
    if (openRef.current) return;
    translateY.setValue(collapsedY);
    dragStartRef.current = collapsedY;
  }, [collapsedY, translateY]);

  const pan = useMemo(() => PanResponder.create({
    // Start-of-touch stays with whatever was touched — that is what keeps the refresh button and
    // the header tap working. Only movement the sheet can actually use claims the gesture.
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => {
      // A grab mid-flight takes over from the spring at its current position.
      translateY.stopAnimation((value) => { dragStartRef.current = value; });
    },
    onPanResponderMove: (_e, g) => {
      translateY.setValue(Math.min(collapsedY, Math.max(0, dragStartRef.current + g.dy)));
    },
    onPanResponderRelease: (_e, g) => {
      // A flick wins over position: a short fast flick means what a long drag means.
      const restingY = dragStartRef.current + g.dy;
      const open = g.vy < -0.35 ? true : g.vy > 0.35 ? false : restingY < collapsedY / 2;
      openRef.current = open;
      animateTo(open ? 0 : collapsedY);
    },
    onPanResponderTerminate: () => animateTo(openRef.current ? 0 : collapsedY),
  }), [animateTo, collapsedY, translateY]);

  const toggle = useCallback(() => {
    openRef.current = !openRef.current;
    animateTo(openRef.current ? 0 : collapsedY);
  }, [animateTo, collapsedY]);

  return (
    <Animated.View style={[s.sheet, { height: expanded }, { transform: [{ translateY }] }]}>
      <View style={[s.head, { height: peek }]} {...pan.panHandlers}>
        <Pressable
          style={s.headPress}
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel="Trip details"
        >
          <View style={s.grab} />
          {header}
        </Pressable>
      </View>
      <ScrollView
        style={s.body}
        contentContainerStyle={s.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </Animated.View>
  );
});

const s = StyleSheet.create({
  /* The sheet is as tall as it will ever be and is slid down instead of resized: a transform
     animates on the UI thread, a height animation re-lays out every card on every frame. The
     screen root clips what slides past the bottom, so the off-screen part cannot paint over the
     tab bar on Android, where elevation alone would draw it there. */
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    shadowColor: '#0f172a', shadowOpacity: 0.18, shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 }, elevation: 16,
  },
  head: { paddingTop: 8, paddingHorizontal: 14 },
  headPress: { flex: 1 },
  grab: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#d1d5db', alignSelf: 'center' },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 28 },
});
