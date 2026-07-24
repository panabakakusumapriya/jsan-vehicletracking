import { useEffect, useRef, useState } from 'react';
import { bearingDeg, lerpHeadingDeg, lerpLatLon } from './geo';

export interface PositionFix {
  lat: number;
  lon: number;
  heading?: number | null;
  recordedAt?: string;
}

export interface AnimatedPosition {
  lat: number;
  lon: number;
  heading: number;
}

const MIN_GLIDE_MS = 800;
const MAX_GLIDE_MS = 8000;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Glides a single vehicle from its last displayed position to each new fix,
 * stretched over the real gap between fixes, instead of snapping instantly.
 * Freezes in place while `stale` is true.
 */
export function useInterpolatedPosition(
  fix: PositionFix | null | undefined,
  stale: boolean
): AnimatedPosition | null {
  const [display, setDisplay] = useState<AnimatedPosition | null>(() =>
    fix ? { lat: fix.lat, lon: fix.lon, heading: fix.heading ?? 0 } : null
  );
  const displayRef = useRef(display);
  displayRef.current = display;

  const animRef = useRef<{
    from: AnimatedPosition;
    to: AnimatedPosition;
    start: number;
    duration: number;
  } | null>(null);
  const lastFixAtRef = useRef(Date.now());
  const lastHeadingRef = useRef(fix?.heading ?? 0);
  const rafRef = useRef<number>();

  useEffect(() => {
    if (!fix) return;
    const now = Date.now();
    const heading = fix.heading ?? lastHeadingRef.current;
    lastHeadingRef.current = heading;

    const from = displayRef.current ?? { lat: fix.lat, lon: fix.lon, heading };
    const gap = now - lastFixAtRef.current;
    lastFixAtRef.current = now;

    animRef.current = {
      from,
      to: { lat: fix.lat, lon: fix.lon, heading },
      start: now,
      duration: Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, gap || MIN_GLIDE_MS)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix?.lat, fix?.lon, fix?.heading, fix?.recordedAt]);

  useEffect(() => {
    if (stale) return;
    const tick = () => {
      const anim = animRef.current;
      if (anim) {
        const t = Math.min(1, (Date.now() - anim.start) / anim.duration);
        const eased = easeOutCubic(t);
        const [lat, lon] = lerpLatLon(anim.from.lat, anim.from.lon, anim.to.lat, anim.to.lon, eased);
        // Bearing between the glide endpoints, not an interpolation between
        // the two recorded heading values -- see TripPathLayer's
        // vehicleAtElapsed for why (sharp turns can make "shortest angular
        // path" spin the icon the wrong way). Falls back to the recorded
        // headings when the two fixes are too close together (e.g. stopped).
        const heading =
          bearingDeg(anim.from.lat, anim.from.lon, anim.to.lat, anim.to.lon) ??
          lerpHeadingDeg(anim.from.heading, anim.to.heading, eased);
        setDisplay({ lat, lon, heading });
        if (t >= 1) animRef.current = null;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [stale]);

  return display;
}
