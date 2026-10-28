import { useEffect, useMemo, useState } from 'react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { api } from '../../lib/api';
import type { TripRouteWeather, TripRouteWeatherSample } from '../../lib/types';
import { RISK_BADGE, RISK_HEX, RISK_LABEL, compass, glyphFor } from './weatherUi';

/**
 * Estimated weather along a finished trip (GET /api/weather/trip-route/:id): where the vehicle was
 * at each moment, matched to the modelled weather for that place and hour.
 *
 * Every view of it says ESTIMATE. It is a weather model's hindcast on a km-scale grid, not a
 * reading from the vehicle, and nobody should mistake it for evidence that it rained on that
 * exact street at that exact minute.
 */
export function useTripRouteWeather(tripId: string | undefined, enabled = true) {
  const [weather, setWeather] = useState<TripRouteWeather | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!tripId || !enabled) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api.get<{ weather: TripRouteWeather | null }>(`/api/weather/trip-route/${tripId}`)
      .then((r) => { if (alive) setWeather(r.weather); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Weather unavailable'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tripId, enabled]);
  return { weather, loading, error };
}

const ms = (s: TripRouteWeatherSample) => new Date(s.at).getTime();

/** The sample in force at a moment: the last one at or before it. */
export function sampleAt(weather: TripRouteWeather | null, atMs: number) {
  if (!weather?.samples.length) return null;
  let hit = weather.samples[0];
  for (const s of weather.samples) {
    if (ms(s) <= atMs) hit = s;
    else break;
  }
  return hit;
}

/** Dots on the 3D route where the weather was looked up, coloured by driving risk; rain rings them. */
export function tripWeatherLayers(weather: TripRouteWeather | null, current: TripRouteWeatherSample | null) {
  if (!weather?.samples.length) return [];
  const hex = (h: string, a = 255): [number, number, number, number] =>
    [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
  const wet = weather.samples.filter((s) => (s.precipMm ?? 0) >= 0.2);
  return [
    new ScatterplotLayer<TripRouteWeatherSample>({
      id: 'trip-weather-rain',
      data: wet,
      getPosition: (s) => [s.lon, s.lat],
      getRadius: (s) => 14 + Math.min(s.precipMm ?? 0, 10) * 4,
      radiusUnits: 'pixels',
      filled: true,
      stroked: false,
      getFillColor: [37, 99, 235, 60],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    }),
    new ScatterplotLayer<TripRouteWeatherSample>({
      id: 'trip-weather-samples',
      data: weather.samples,
      getPosition: (s) => [s.lon, s.lat],
      getRadius: (s) => (s === current ? 9 : 6),
      radiusUnits: 'pixels',
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (s) => (s === current ? 3 : 2),
      getLineColor: [255, 255, 255, 255],
      getFillColor: (s) => hex(RISK_HEX[s.risk ?? 'clear']),
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
      updateTriggers: { getRadius: current?.at, getLineWidth: current?.at },
    }),
  ];
}

/** "Weather now" for the replay's current moment, laid over the map. */
export function WeatherNowChip({ sample }: { sample: TripRouteWeatherSample | null }) {
  if (!sample?.risk) return null;
  return (
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 2, maxWidth: 'calc(100% - 24px)',
      background: 'var(--panel)', border: '1px solid var(--line-2)', borderLeft: `4px solid ${RISK_HEX[sample.risk]}`,
      borderRadius: 'var(--radius)', padding: '7px 11px', boxShadow: '0 1px 6px rgba(0,0,0,0.14)',
      fontSize: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 22, lineHeight: 1 }}>{glyphFor(sample.icon)}</span>
      <span>
        <b style={{ fontSize: 13 }}>{sample.tempC ?? '—'}°C</b>{' '}
        <span style={{ color: 'var(--text-2)' }}>{sample.description}</span>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {new Date(sample.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · km {sample.kmFromStart}
        </div>
      </span>
      <Fact label="Rain" value={`${sample.precipMm ?? 0} mm/h`} warn={(sample.precipMm ?? 0) >= 2} />
      <Fact label="Wind" value={`${compass(sample.windDirDeg)} ${sample.windKmh ?? '—'}${sample.gustKmh ? `/${sample.gustKmh}` : ''} km/h`}
        warn={(sample.gustKmh ?? 0) >= 40} />
      <Fact label="Visibility" value={sample.visibilityKm == null ? '—' : `${sample.visibilityKm} km`} warn={(sample.visibilityKm ?? 99) < 4} />
      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: '#b45309',
        border: '1px solid #f0b429', background: 'rgba(217,119,6,0.10)', borderRadius: 4, padding: '1px 6px' }}
        title="Modelled from a weather model's hindcast for this place and hour — not measured by the vehicle">
        estimate
      </span>
    </div>
  );
}

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
      <span style={{ fontSize: 9.5, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      <span style={{ fontWeight: 700, color: warn ? '#c2410c' : 'var(--text)' }}>{value}</span>
    </span>
  );
}

/**
 * The weather timeline under the replay: one tile per sample at its moment in the trip, a playhead
 * at the replay's position, click a tile to jump there.
 */
export function TripWeatherStrip({
  weather, loading, error, startMs, durationMs, currentMs, onSeek,
}: {
  weather: TripRouteWeather | null;
  loading: boolean;
  error: string | null;
  startMs: number;
  durationMs: number;
  currentMs?: number;
  onSeek?: (elapsedMs: number) => void;
}) {
  const samples = weather?.samples ?? [];
  const current = useMemo(
    () => (currentMs == null ? null : sampleAt(weather, startMs + currentMs)),
    [weather, startMs, currentMs]
  );

  if (loading) return <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 2px' }}>Looking up the weather along this route…</div>;
  if (error) return <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 2px' }}>Weather along the route is unavailable: {error}</div>;
  if (!weather || !samples.length) return null;

  const sum = weather.summary;
  const pos = (s: TripRouteWeatherSample) =>
    durationMs > 0 ? Math.min(Math.max(((ms(s) - startMs) / durationMs) * 100, 0), 100) : 0;

  return (
    <div style={{ marginTop: 10, padding: '10px 14px 12px', background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>Weather along the route</b>
        <span className={`badge ${RISK_BADGE[weather.verdict]}`} style={{ fontSize: 10 }}>{RISK_LABEL[weather.verdict]}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
          {sum.tempMinC != null && `${sum.tempMinC}–${sum.tempMaxC}°C`}
          {sum.wetSamples > 0 ? ` · rain at ${sum.wetSamples} of ${samples.length} points (up to ${sum.maxPrecipMm} mm/h)` : ' · dry'}
          {sum.gustMaxKmh != null && ` · gusts to ${sum.gustMaxKmh} km/h`}
          {sum.visibilityMinKm != null && sum.visibilityMinKm < 10 && ` · visibility down to ${sum.visibilityMinKm} km`}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }} title={weather.source}>
          Estimated from a weather model for each place and time — not measured by the vehicle
        </span>
      </div>

      {/* Tiles in time order; a long trip scrolls sideways. The bar below places them on the clock. */}
      <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
        {samples.map((s) => (
          <button
            key={s.at}
            type="button"
            onClick={() => onSeek?.(Math.max(0, ms(s) - startMs))}
            title={`${new Date(s.at).toLocaleTimeString()} · km ${s.kmFromStart} · ${s.description ?? ''}${s.reasons?.length ? ` — ${s.reasons.join(', ')}` : ''}`}
            style={{
              flex: '0 0 auto', minWidth: 60, textAlign: 'center', padding: '5px 4px 4px', borderRadius: 8,
              cursor: onSeek ? 'pointer' : 'default', font: 'inherit',
              background: s.risk === 'unsafe' ? 'var(--red-bg)' : s.risk === 'caution' ? 'var(--amber-bg)' : 'var(--panel-2)',
              border: s === current ? '2px solid var(--brand)' : `1px solid ${s.risk && s.risk !== 'clear' ? RISK_HEX[s.risk] + '55' : 'var(--line)'}`,
            }}
          >
            <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700 }}>
              {new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
            <div style={{ fontSize: 17, lineHeight: 1.25 }}>{glyphFor(s.icon)}</div>
            <div style={{ fontSize: 12, fontWeight: 800 }}>{s.tempC ?? '—'}°</div>
            <div style={{ fontSize: 9.5, color: (s.precipMm ?? 0) > 0 ? '#2563eb' : 'var(--muted)', fontWeight: 700 }}>
              {(s.precipMm ?? 0) > 0 ? `${s.precipMm} mm` : 'dry'}
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--muted)' }}>{s.windKmh ?? '—'} km/h</div>
            <div style={{ fontSize: 9, color: 'var(--muted)' }}>km {s.kmFromStart}</div>
          </button>
        ))}
      </div>

      {durationMs > 0 && (
        <div style={{ position: 'relative', height: 10, marginTop: 6, borderRadius: 5, background: 'var(--panel-2)', border: '1px solid var(--line)' }}>
          {samples.map((s, i) => {
            const next = samples[i + 1];
            const left = pos(s);
            const width = (next ? pos(next) : 100) - left;
            return (
              <span key={s.at} title={`${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${s.description ?? ''}`}
                onClick={() => onSeek?.(Math.max(0, ms(s) - startMs))}
                style={{
                  position: 'absolute', top: 0, bottom: 0, left: `${left}%`, width: `${Math.max(width, 0.6)}%`,
                  background: (s.precipMm ?? 0) >= 0.2 ? '#2563eb' : RISK_HEX[s.risk ?? 'clear'],
                  opacity: (s.precipMm ?? 0) >= 0.2 ? 0.35 + Math.min((s.precipMm ?? 0) / 8, 0.6) : s.risk === 'clear' ? 0.25 : 0.8,
                  cursor: onSeek ? 'pointer' : 'default',
                }} />
            );
          })}
          {currentMs != null && (
            <span style={{
              position: 'absolute', top: -3, bottom: -3, width: 2, background: 'var(--text)',
              left: `${Math.min(Math.max((currentMs / durationMs) * 100, 0), 100)}%`,
            }} />
          )}
        </div>
      )}
      {durationMs > 0 && (
        <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>
          <span><span style={{ display: 'inline-block', width: 9, height: 7, background: '#2563eb', opacity: 0.7, marginRight: 4 }} />rain</span>
          <span><span style={{ display: 'inline-block', width: 9, height: 7, background: RISK_HEX.caution, marginRight: 4 }} />caution</span>
          <span><span style={{ display: 'inline-block', width: 9, height: 7, background: RISK_HEX.unsafe, marginRight: 4 }} />unsafe to drive</span>
        </div>
      )}
    </div>
  );
}
