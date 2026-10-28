import { useMemo, type ReactNode } from 'react';
import type { WeatherHour } from '../../lib/types';
import { RISK_HEX, compass, glyphFor } from './weatherUi';

/**
 * One local day, hour by hour: the risk band, the condition, temperature as a line, rain as bars
 * (with the chance of rain behind them), wind and gusts, the direction it blows from, and
 * visibility. The columns are the same width as the date cards' rhythm and scroll sideways on a
 * narrow screen rather than squeezing 24 hours into illegibility.
 *
 * Hours already gone are dimmed, not hidden — the manager asking "why did coverage stop at ten"
 * wants to see the storm that passed.
 */
const COL = 46;
const TOP = 58; // risk band + time + icon
const CHART = 120;
const ROWS = 54; // wind + visibility text rows
const PAD = 14;

export function HourlyChart({ hours }: { hours: WeatherHour[] }) {
  const geo = useMemo(() => {
    const temps = hours.map((h) => h.tempC).filter((t): t is number => t != null);
    const tMin = temps.length ? Math.min(...temps) : 0;
    const tMax = temps.length ? Math.max(...temps) : 1;
    const tSpan = Math.max(tMax - tMin, 4);
    // Rain is scaled to at least 4 mm so a 0.2 mm drizzle reads as small, not as a full bar.
    const rainMax = Math.max(4, ...hours.map((h) => h.precipMm || 0));
    const windMax = Math.max(40, ...hours.map((h) => Math.max(h.windKmh ?? 0, h.gustKmh ?? 0)));
    const x = (i: number) => i * COL + COL / 2;
    const yT = (t: number) => TOP + PAD + (1 - (t - tMin) / tSpan) * (CHART - 2 * PAD - 18);
    const yW = (w: number) => TOP + CHART - (w / windMax) * (CHART - 30);
    return { tMin, tMax, rainMax, windMax, x, yT, yW };
  }, [hours]);

  if (!hours.length) return null;
  const { rainMax, x, yT, yW } = geo;
  const width = hours.length * COL;
  const height = TOP + CHART + ROWS;
  const pts = (key: 'tempC' | 'windKmh' | 'gustKmh', y: (v: number) => number) =>
    hours.map((h, i) => (h[key] == null ? null : `${x(i)},${y(h[key] as number)}`)).filter(Boolean).join(' ');

  return (
    <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', minWidth: width }}
        role="img" aria-label="Hourly forecast: temperature, rain, wind and visibility">
        {hours.map((h, i) => (
          <g key={h.dt} opacity={h.past ? 0.42 : 1}>
            <title>{`${h.at} · ${h.description}${h.reasons.length ? ` — ${h.reasons.join(', ')}` : ''}`}</title>
            {/* risk band */}
            <rect x={i * COL + 1} y={0} width={COL - 2} height={5} rx={2} fill={RISK_HEX[h.risk]} opacity={h.risk === 'clear' ? 0.35 : 0.95} />
            {i % 2 === 0 && <rect x={i * COL} y={8} width={COL} height={TOP + CHART + ROWS - 8} fill="var(--panel-2)" opacity={0.55} />}
            <text x={x(i)} y={21} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="var(--muted)">{h.at}</text>
            <text x={x(i)} y={45} textAnchor="middle" fontSize={19}>{glyphFor(h.icon)}</text>
            {/* chance of rain, then the amount over it */}
            {h.popPct > 0 && (
              <rect x={x(i) - 13} y={TOP + CHART - (h.popPct / 100) * (CHART - 26)} width={26}
                height={(h.popPct / 100) * (CHART - 26)} fill="#60a5fa" opacity={0.13} rx={3} />
            )}
            {h.precipMm > 0 && (
              <rect x={x(i) - 9} y={TOP + CHART - (h.precipMm / rainMax) * (CHART - 26)} width={18}
                height={Math.max(2, (h.precipMm / rainMax) * (CHART - 26))} fill="#2563eb" opacity={0.85} rx={3} />
            )}
            {h.precipMm > 0 && (
              <text x={x(i)} y={TOP + CHART - 4 - (h.precipMm / rainMax) * (CHART - 26)} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#2563eb">
                {h.precipMm}
              </text>
            )}
          </g>
        ))}

        {/* gusts (dashed) and wind (solid), on their own scale at the bottom of the chart */}
        <polyline points={pts('gustKmh', yW)} fill="none" stroke="#94a3b8" strokeWidth={1.4} strokeDasharray="3 3" />
        <polyline points={pts('windKmh', yW)} fill="none" stroke="#64748b" strokeWidth={1.8} />
        {/* temperature */}
        <polyline points={pts('tempC', yT)} fill="none" stroke="#f97316" strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
        {hours.map((h, i) => h.tempC == null ? null : (
          <g key={`t${h.dt}`} opacity={h.past ? 0.42 : 1}>
            <circle cx={x(i)} cy={yT(h.tempC)} r={2.6} fill="#f97316" />
            <text x={x(i)} y={yT(h.tempC) - 7} textAnchor="middle" fontSize={10.5} fontWeight={800} fill="var(--text)">{h.tempC}°</text>
          </g>
        ))}

        {/* wind + visibility rows */}
        {hours.map((h, i) => (
          <g key={`r${h.dt}`} opacity={h.past ? 0.42 : 1}>
            {h.windDirDeg != null && (
              // The arrow points where the wind blows TO (the reading is where it comes from).
              <g transform={`translate(${x(i)},${TOP + CHART + 13}) rotate(${h.windDirDeg + 180})`}>
                <path d="M0,-6 L4,4 L0,2 L-4,4 Z" fill="#64748b" />
              </g>
            )}
            <text x={x(i)} y={TOP + CHART + 32} textAnchor="middle" fontSize={10}
              fill={(h.gustKmh ?? 0) >= 60 ? RISK_HEX.unsafe : (h.gustKmh ?? h.windKmh ?? 0) >= 40 ? RISK_HEX.caution : 'var(--text-2)'}
              fontWeight={600}>
              <title>{`${compass(h.windDirDeg)} wind ${h.windKmh ?? '—'} km/h, gusts ${h.gustKmh ?? '—'} km/h`}</title>
              {h.windKmh ?? '—'}{h.gustKmh && h.windKmh != null && h.gustKmh > h.windKmh ? `/${h.gustKmh}` : ''}
            </text>
            <text x={x(i)} y={TOP + CHART + 47} textAnchor="middle" fontSize={10}
              fill={h.visibilityKm != null && h.visibilityKm < 1 ? RISK_HEX.unsafe : h.visibilityKm != null && h.visibilityKm < 4 ? RISK_HEX.caution : 'var(--muted)'}>
              {h.visibilityKm == null ? '—' : h.visibilityKm >= 20 ? '20+' : h.visibilityKm.toFixed(h.visibilityKm < 10 ? 1 : 0)}
            </text>
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>
        <Key swatch={<span style={{ width: 14, height: 3, background: '#f97316', borderRadius: 2 }} />} label="Temperature °C" />
        <Key swatch={<span style={{ width: 9, height: 10, background: '#2563eb', borderRadius: 2 }} />} label="Rain mm" />
        <Key swatch={<span style={{ width: 9, height: 10, background: '#60a5fa', opacity: 0.35, borderRadius: 2 }} />} label="Chance of rain" />
        <Key swatch={<span style={{ width: 14, height: 2, background: '#64748b' }} />} label="Wind km/h (/gusts)" />
        <Key swatch={<span style={{ fontSize: 10 }}>⇣</span>} label="Wind blowing towards" />
        <Key swatch={<span style={{ fontSize: 10, fontWeight: 700 }}>km</span>} label="Visibility (bottom row)" />
      </div>
    </div>
  );
}

function Key({ swatch, label }: { swatch: ReactNode; label: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>{swatch}{label}</span>;
}
