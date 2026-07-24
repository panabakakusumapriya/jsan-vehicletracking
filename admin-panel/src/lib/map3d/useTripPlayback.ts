import { useEffect, useRef, useState } from 'react';

export interface TripPlaybackPoint {
  recordedAt: string;
}

export interface TripPlayback {
  currentTimeMs: number;
  durationMs: number;
  playing: boolean;
  speed: number;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  setSpeed(mult: number): void;
}

/** Play/pause/scrub/speed control over a fixed set of recorded trip points. */
export function useTripPlayback(points: TripPlaybackPoint[]): TripPlayback {
  const durationMs =
    points.length > 1
      ? new Date(points[points.length - 1].recordedAt).getTime() - new Date(points[0].recordedAt).getTime()
      : 0;

  // Starts (and resets, when the trip changes) at the END of the trip --
  // TripsLayer only draws vertices up to `currentTime`, so starting at 0
  // would render just the very first GPS point until Play is pressed. This
  // way the full route is visible by default; pressing Play rewinds to 0
  // and animates forward from there (see `play` below).
  const [currentTimeMs, setCurrentTimeMs] = useState(durationMs);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const rafRef = useRef<number>();
  const lastTickRef = useRef(0);

  // Reset playback whenever the underlying trip's points change.
  useEffect(() => {
    setCurrentTimeMs(durationMs);
    setPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;
      setCurrentTimeMs((prev) => {
        const next = prev + delta * speed;
        if (next >= durationMs) {
          setPlaying(false);
          return durationMs;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speed, durationMs]);

  return {
    currentTimeMs,
    durationMs,
    playing,
    speed,
    play: () => {
      if (durationMs <= 0) return;
      setCurrentTimeMs((prev) => (prev >= durationMs ? 0 : prev));
      setPlaying(true);
    },
    pause: () => setPlaying(false),
    seek: (ms: number) => setCurrentTimeMs(Math.min(durationMs, Math.max(0, ms))),
    setSpeed,
  };
}
