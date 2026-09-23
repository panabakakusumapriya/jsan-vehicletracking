export type DistanceMode = 'raw' | 'cleaned';

interface DistanceModeToggleProps {
  mode: DistanceMode;
  onChange: (mode: DistanceMode) => void;
  /** Whether a Valhalla-matched route actually exists yet — disables "Snapped" until it does. */
  cleanedAvailable: boolean;
}

/**
 * Raw vs. snapped(-to-road) distance/route toggle — shared between TripDetail and Reports.
 * "Snapped" is disabled (not hidden) until the trip has actually been map-matched, so the
 * control's existence hints at the feature even before the background worker has caught up.
 */
export function DistanceModeToggle({ mode, onChange, cleanedAvailable }: DistanceModeToggleProps) {
  return (
    <div className="distance-mode-control" role="group" aria-label="Route display">
      {(['raw', 'cleaned'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="btn-ghost"
          aria-pressed={mode === m}
          disabled={m === 'cleaned' && !cleanedAvailable}
          title={m === 'cleaned' && !cleanedAvailable ? 'Not map-matched yet' : undefined}
          onClick={() => onChange(m)}
          style={{
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 700,
            background: mode === m ? 'var(--brand-light)' : undefined,
            color: mode === m ? 'var(--brand)' : undefined,
            opacity: m === 'cleaned' && !cleanedAvailable ? 0.5 : 1,
          }}
        >
          {m === 'raw' ? 'Raw GPS' : 'Snapped to road'}
        </button>
      ))}
    </div>
  );
}
