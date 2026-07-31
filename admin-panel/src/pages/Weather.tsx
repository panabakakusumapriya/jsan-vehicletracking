import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { DrivingRisk, DrivingWeather, WeatherGroup, WeatherSlot } from '../lib/types';

/**
 * Can today's driving happen?
 *
 * Grouped by location rather than by driver — twenty drivers at one depot is one card, not
 * twenty rows — and sorted worst-first so anything needing a decision is at the top. Most
 * days the honest answer is "all clear", and the page should say so in one glance.
 *
 * Every verdict shows the numbers behind it. This is decision support, not a safety ruling.
 */

const RISK_LABEL: Record<DrivingRisk, string> = {
  clear: 'Good to drive',
  caution: 'Drive with caution',
  unsafe: 'Do not drive',
};
const RISK_BADGE: Record<DrivingRisk, string> = { clear: 'green', caution: 'amber', unsafe: 'red' };
const RISK_DOT: Record<DrivingRisk, string> = { clear: '🟢', caution: '🟠', unsafe: '🔴' };
const RISK_COLOR: Record<DrivingRisk, string> = {
  clear: 'var(--green)', caution: 'var(--amber)', unsafe: 'var(--red)',
};

const DAYS = [
  { offset: 0, label: 'Today' },
  { offset: 1, label: 'Tomorrow' },
  { offset: 2, label: '+2 days' },
  { offset: 3, label: '+3 days' },
  { offset: 4, label: '+4 days' },
];

/**
 * Our own icon names (see backend weatherCodes.js) mapped to a glyph.
 *
 * Open-Meteo returns codes, not images. Rendering them locally means no third-party image
 * host to allow through a CSP, nothing extra to download, and no broken icons if that host
 * ever disappears.
 */
const ICONS: Record<string, string> = {
  'sun-d': '☀️', 'sun-n': '🌙', 'partly-d': '⛅', 'partly-n': '☁️',
  cloud: '☁️', fog: '🌫️', drizzle: '🌦️', rain: '🌧️',
  showers: '🌦️', snow: '🌨️', storm: '⛈️',
};
const glyphFor = (icon: string | null) => (icon && ICONS[icon]) || '·';

function Slot({ slot }: { slot: WeatherSlot }) {
  return (
    <div
      title={`${slot.at} · ${slot.description}${slot.reasons.length ? ` — ${slot.reasons.join(', ')}` : ''}`}
      style={{
        flex: '1 1 0', minWidth: 62, textAlign: 'center',
        padding: '8px 4px 6px', borderRadius: 9,
        background: slot.risk === 'clear' ? 'var(--panel-2)' : slot.risk === 'caution' ? 'var(--amber-bg)' : 'var(--red-bg)',
        border: `1px solid ${slot.risk === 'clear' ? 'var(--line)' : RISK_COLOR[slot.risk]}33`,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{slot.at}</div>
      <div style={{ fontSize: 20, lineHeight: 1.3 }}>{glyphFor(slot.icon)}</div>
      <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>
        {slot.tempC != null ? `${slot.tempC}°` : '—'}
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.35 }}>
        {slot.windKmh != null && <div>{slot.gustKmh && slot.gustKmh > slot.windKmh ? `${slot.gustKmh}g` : slot.windKmh} km/h</div>}
        {slot.popPct > 0 && <div>{slot.popPct}%</div>}
      </div>
    </div>
  );
}

function LocationCard({ group }: { group: WeatherGroup }) {
  const verdict = group.verdict ?? 'clear';
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', borderLeft: `4px solid ${RISK_COLOR[verdict]}` }}>
      <div style={{ padding: '14px 18px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
                {RISK_DOT[verdict]} {group.place || `${group.lat.toFixed(2)}, ${group.lon.toFixed(2)}`}
                {group.country ? `, ${group.country}` : ''}
              </span>
              <span className={`badge ${RISK_BADGE[verdict]}`}>{RISK_LABEL[verdict]}</span>
              {group.stale && (
                <span className="badge gray" title="The weather service was unreachable; showing the last forecast we hold.">
                  stale
                </span>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 4 }}>{group.headline}</div>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'right' }}>
            <div>local time {group.localTimeNow}</div>
            <div>{group.drivers.length} driver{group.drivers.length === 1 ? '' : 's'}</div>
          </div>
        </div>

        {group.slots.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 12, overflowX: 'auto' }}>
            {group.slots.map(s => <Slot key={s.dt} slot={s} />)}
          </div>
        )}
      </div>

      <div style={{
        padding: '9px 18px', background: 'var(--panel-2)', borderTop: '1px solid var(--line)',
        display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
      }}>
        {group.drivers.map(d => (
          <span key={d._id} style={{
            fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)',
            background: 'var(--panel)', border: '1px solid var(--line-2)',
            borderRadius: 999, padding: '2px 10px',
          }}>
            {d.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Weather() {
  const [day, setDay] = useState(0);
  const [data, setData] = useState<DrivingWeather | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.get<DrivingWeather>(`/api/weather/driving?day=${day}`)
      .then(r => { if (alive) setData(r); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Could not load the forecast'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [day, reloadKey]);

  const t = data?.thresholds;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Weather</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Driving conditions where your drivers actually are
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="input" style={{ width: 140 }} value={day} onChange={e => setDay(Number(e.target.value))}>
            {DAYS.map(d => <option key={d.offset} value={d.offset}>{d.label}</option>)}
          </select>
          <button className="btn-ghost" onClick={() => setReloadKey(k => k + 1)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {data?.configured && (
        <>
          <div className="stat-row">
            <div className="stat"><div className="v" style={{ color: 'var(--green)' }}>{data.totals.clear}</div><div className="k">Good to drive</div></div>
            <div className="stat"><div className="v" style={{ color: 'var(--amber)' }}>{data.totals.caution}</div><div className="k">Caution</div></div>
            <div className="stat"><div className="v" style={{ color: data.totals.unsafe ? 'var(--red)' : undefined }}>{data.totals.unsafe}</div><div className="k">Do not drive</div></div>
            <div className="stat"><div className="v">{data.totals.unplaced}</div><div className="k">No recent location</div></div>
            <div className="stat"><div className="v">{data.totals.locations ?? 0}</div><div className="k">Locations</div></div>
          </div>

          {data.failures && data.failures.length > 0 && (
            <div className="error-text">
              {data.failures.length} location{data.failures.length === 1 ? '' : 's'} could not be
              fetched: {data.failures[0]}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.groups.map(g => <LocationCard key={g.key} group={g} />)}
          </div>

          {/* Only claim "nobody reported a position" when that is actually why the list is
              empty. If lookups failed, drivers DID report — the forecast is what's missing,
              and the banner above already says so. Blaming the wrong thing sends someone
              hunting through trip data for a problem that is really an API key. */}
          {data.groups.length === 0 && !loading && !data.failures?.length && (
            <div className="empty-state">
              <p>
                No driver has reported a position in the last {t?.activeDays ?? 7} days, so there's
                nowhere to check the weather for.
              </p>
            </div>
          )}
          {data.groups.length === 0 && !loading && !!data.failures?.length && (
            <div className="empty-state">
              <p>
                Driver positions were found, but the forecast for them couldn't be fetched — see
                the message above. Nothing else is wrong; this page fills in as soon as the
                weather service answers.
              </p>
            </div>
          )}

          {data.unplaced.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 13.5 }}>
                No recent location ({data.unplaced.length})
              </h3>
              <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                No trip in the last {t?.activeDays ?? 7} days, so we have no position we'd trust.
                An old fix would confidently show the weather for a city they may have left.
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {data.unplaced.map(d => (
                  <span key={d._id} style={{
                    fontSize: 11.5, color: 'var(--muted)',
                    background: 'var(--panel-2)', border: '1px solid var(--line)',
                    borderRadius: 999, padding: '2px 10px',
                  }}>
                    {d.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {t && (
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 14, lineHeight: 1.65 }}>
              Guidance only — check the numbers and use your judgement. Flagged as <b>do not drive</b> for
              thunderstorms, heavy rain or snow, freezing rain, visibility under 1 km, or gusts over{' '}
              {t.gustUnsafeKmh} km/h; <b>caution</b> for moderate rain, fog, visibility under 4 km, or wind
              over {t.windCautionKmh} km/h. Thresholds are set for high-sided vans. Forecasts are cached
              for {t.cacheMinutes} minutes and shared between drivers within about 25 km.
            </p>
          )}
        </>
      )}
    </div>
  );
}
