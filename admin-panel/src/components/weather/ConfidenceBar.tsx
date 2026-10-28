import { CONFIDENCE_HEX, CONFIDENCE_LABEL, confidenceLevel } from './weatherUi';

/**
 * How much to trust a forecast day, as a bar: how closely three independent weather models
 * (ECMWF, GFS, ICON) agree on that day's temperature, wind and rain, less a little per day ahead
 * (services/forecastConfidence.js). The reasons are the tooltip and, with `showReasons`, a line.
 */
export function ConfidenceBar({
  score, reasons, compact, showReasons,
}: {
  score: number | null | undefined;
  reasons?: string[];
  compact?: boolean;
  showReasons?: boolean;
}) {
  if (score == null) return null;
  const level = confidenceLevel(score);
  const color = CONFIDENCE_HEX[level];
  const why = reasons?.length ? reasons.join(' · ') : '';
  const tip = `${CONFIDENCE_LABEL[level]} (${score}%) — how closely three independent weather models agree on this day${why ? `: ${why}` : ''}`;
  return (
    <div title={tip} style={{ minWidth: compact ? 0 : 150 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6, fontSize: compact ? 9.5 : 10.5, fontWeight: 700 }}>
        <span style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{compact ? 'Confidence' : 'Forecast confidence'}</span>
        <span style={{ color }}>{compact ? `${score}%` : `${CONFIDENCE_LABEL[level].split(' ')[0]} · ${score}%`}</span>
      </div>
      <div style={{ height: compact ? 5 : 6, borderRadius: 3, background: 'var(--panel-2)', border: '1px solid var(--line)', overflow: 'hidden', marginTop: 2 }}
        role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label={CONFIDENCE_LABEL[level]}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      {showReasons && why && (
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.35 }}>{why}</div>
      )}
    </div>
  );
}
