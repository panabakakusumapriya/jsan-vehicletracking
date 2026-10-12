import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PageIcon } from '../components/AppIcon';
import { api, viewerTimeZone } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * The superadmin dashboard — the whole fleet, cut by project, region and country, over a period.
 *
 * One request (GET /api/analytics/overview) carries everything: totals with the change against the
 * previous period of the same length, a timeline, the three breakdowns and the top drivers. Every
 * breakdown adds up to the totals. Clicking a bar filters the whole page by it; a chart keeps
 * showing all of its own bars while filtered, with the selected one highlighted.
 *
 * Colour: one hue for magnitude (the reference palette's blue), dimmed for what is not selected —
 * the charts are single-series, so nothing here needs a legend.
 */

type Row = {
  key: string; name: string; drivers: number; activeDrivers: number; drivingDrivers: number;
  trips: number; km: number; ukm: number; assignedUkm: number; outsideUkm: number; workMs: number; markers: number;
};
type Overview = {
  period: { from: string; to: string; days: number; unit: 'day' | 'week' | 'month'; previousFrom: string; previousTo: string };
  totals: Omit<Row, 'key' | 'name'>;
  previous: { trips: number; km: number; ukm: number; workMs: number; drivingDrivers: number };
  byProject: Row[]; byRegion: Row[]; byCountry: Row[];
  timeline: { date: string; trips: number; km: number; ukm: number; workMs: number; drivers: number }[];
  topDrivers: { driverId: string; name: string; project: string | null; country: string; region: string; active: boolean; trips: number; days: number; km: number; ukm: number; workMs: number }[];
};

type Measure = 'km' | 'trips' | 'drivingDrivers' | 'workMs' | 'ukm';
const MEASURES: { key: Measure; label: string }[] = [
  { key: 'km', label: 'Km driven' },
  { key: 'trips', label: 'Trips' },
  { key: 'drivingDrivers', label: 'Drivers driving' },
  { key: 'workMs', label: 'Working hours' },
  { key: 'ukm', label: 'UKM' },
];

const BLUE = '#2a78d6';
const nf = new Intl.NumberFormat();
const km = (m: number) => nf.format(Math.round(m / 1000));
const hours = (ms: number) => nf.format(Math.round(ms / 3600000));
const fmt = (m: Measure, v: number) =>
  m === 'km' || m === 'ukm' ? `${km(v)} km` : m === 'workMs' ? `${hours(v)} h` : nf.format(v);

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const PRESETS: { key: string; label: string; from: () => string }[] = [
  { key: '7', label: '7 days', from: () => daysAgo(6) },
  { key: '30', label: '30 days', from: () => daysAgo(29) },
  { key: '90', label: '90 days', from: () => daysAgo(89) },
  { key: 'year', label: 'This year', from: () => `${new Date().getFullYear()}-01-01` },
  { key: 'all', label: 'All time', from: () => '2025-01-01' },
];

const fmtDate = (s: string, unit: 'day' | 'week' | 'month') => {
  const d = new Date(`${s}T00:00:00`);
  return unit === 'month'
    ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

function Delta({ now, before, none }: { now: number; before: number; none?: boolean }) {
  // Nothing at all in the period before: there is nothing to compare with — say so, not "new".
  if (none) return <span className="dash-delta flat">no earlier data</span>;
  if (!before && !now) return <span className="dash-delta flat">—</span>;
  if (!before) return <span className="dash-delta up">new</span>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span className="dash-delta flat">no change</span>;
  return <span className={`dash-delta ${pct > 0 ? 'up' : 'down'}`}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%</span>;
}

export function Dashboard() {
  const { user } = useAuth();
  const [preset, setPreset] = useState('30');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(iso(new Date()));
  const [filter, setFilter] = useState<{ projectId?: string; region?: string; country?: string }>({});
  const [measure, setMeasure] = useState<Measure>('km');
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (user?.role !== 'superadmin') return;
    const q = new URLSearchParams({ from, to, tz: viewerTimeZone() });
    if (filter.projectId) q.set('projectId', filter.projectId);
    if (filter.region) q.set('region', filter.region);
    if (filter.country) q.set('country', filter.country);
    setLoading(true);
    api.get<Overview>(`/api/analytics/overview?${q}`)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the dashboard'))
      .finally(() => setLoading(false));
  }, [user?.role, from, to, filter]);

  const toggle = (dim: 'projectId' | 'region' | 'country', key: string) =>
    setFilter((f) => ({ ...f, [dim]: f[dim] === key ? undefined : key }));
  const projectName = useMemo(
    () => (filter.projectId && data ? data.byProject.find((p) => p.key === filter.projectId)?.name : null),
    [filter.projectId, data],
  );

  if (user && user.role !== 'superadmin') return <Navigate to="/" replace />;

  const t = data?.totals;
  const p = data?.previous;
  const noEarlier = Boolean(p && !p.trips);
  const timelineMax = data ? Math.max(1, ...data.timeline.map((b) => b[measure === 'drivingDrivers' ? 'drivers' : measure])) : 1;
  const tv = (b: Overview['timeline'][number]) => b[measure === 'drivingDrivers' ? 'drivers' : measure];

  return (
    <div className="list-page dash">
      <style>{STYLE}</style>
      <div className="dr-bar" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <h1 className="dr-title"><PageIcon name="dashboard" />Dashboard</h1>
        <div className="dash-seg" role="group" aria-label="Period">
          {PRESETS.map((pr) => (
            <button key={pr.key} className={preset === pr.key ? 'on' : ''}
              onClick={() => { setPreset(pr.key); setFrom(pr.from()); setTo(iso(new Date())); }}>
              {pr.label}
            </button>
          ))}
        </div>
        <span className="dash-range">
          <input className="input" type="date" value={from} max={to} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }} aria-label="From" />
          <span>to</span>
          <input className="input" type="date" value={to} min={from} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }} aria-label="To" />
        </span>
        {(filter.projectId || filter.region || filter.country) && (
          <span className="dash-filters">
            {filter.projectId && <button onClick={() => toggle('projectId', filter.projectId!)}>Project: {projectName ?? '…'} ✕</button>}
            {filter.region && <button onClick={() => toggle('region', filter.region!)}>Region: {filter.region} ✕</button>}
            {filter.country && <button onClick={() => toggle('country', filter.country!)}>Country: {filter.country} ✕</button>}
            <button className="clear" onClick={() => setFilter({})}>Clear all</button>
          </span>
        )}
        {loading && <span className="muted" style={{ fontSize: 12.5 }}>Updating…</span>}
      </div>

      {error && <div className="card" style={{ color: 'var(--red)', padding: 16 }}>{error}</div>}

      {data && t && p && (
        <div className="dash-body">
          <div className="dash-kpis">
            <div className="dash-kpi">
              <div className="k">Drivers</div>
              <div className="v">{nf.format(t.activeDrivers)}<small> active</small></div>
              <div className="s">{nf.format(t.drivers)} on the books</div>
            </div>
            <div className="dash-kpi">
              <div className="k">Drivers driving</div>
              <div className="v">{nf.format(t.drivingDrivers)}</div>
              <div className="s"><Delta none={noEarlier} now={t.drivingDrivers} before={p.drivingDrivers} />{noEarlier ? '' : ` vs previous ${data.period.days} days`}</div>
            </div>
            <div className="dash-kpi">
              <div className="k">Km driven</div>
              <div className="v">{km(t.km)}<small> km</small></div>
              <div className="s"><Delta none={noEarlier} now={t.km} before={p.km} /> · {t.drivingDrivers ? km(t.km / t.drivingDrivers) : 0} km per driver</div>
            </div>
            <div className="dash-kpi">
              <div className="k">Trips</div>
              <div className="v">{nf.format(t.trips)}</div>
              <div className="s"><Delta none={noEarlier} now={t.trips} before={p.trips} /></div>
            </div>
            <div className="dash-kpi">
              <div className="k">Working hours</div>
              <div className="v">{hours(t.workMs)}<small> h</small></div>
              <div className="s"><Delta none={noEarlier} now={t.workMs} before={p.workMs} /></div>
            </div>
            <div className="dash-kpi">
              <div className="k">UKM</div>
              <div className="v">{km(t.ukm)}<small> km</small></div>
              <div className="s">{km(t.assignedUkm)} assigned · {km(t.outsideUkm)} outside</div>
            </div>
            <div className="dash-kpi">
              <div className="k">Markers</div>
              <div className="v">{nf.format(t.markers)}</div>
              <div className="s">flags dropped by drivers</div>
            </div>
          </div>

          <div className="dash-measure" role="group" aria-label="Measure">
            <span>Show</span>
            {MEASURES.map((m) => (
              <button key={m.key} className={measure === m.key ? 'on' : ''} onClick={() => setMeasure(m.key)}>{m.label}</button>
            ))}
          </div>

          <div className="card dash-card">
            <div className="dash-card-head">
              <h3>{MEASURES.find((m) => m.key === measure)!.label} by {data.period.unit}</h3>
              <span className="muted">{fmtDate(data.period.from, 'day')} – {fmtDate(data.period.to, 'day')}</span>
            </div>
            <div className="dash-timeline" onMouseLeave={() => setHover(null)}>
              <div className="dash-grid">
                {[1, 0.5, 0].map((f) => (
                  <div key={f} style={{ bottom: `${f * 100}%` }}><span>{fmt(measure, timelineMax * f)}</span></div>
                ))}
              </div>
              <div className="dash-cols">
                {data.timeline.map((b, i) => (
                  <div key={b.date} className="dash-col" onMouseEnter={() => setHover(i)}>
                    <div className="bar" style={{ height: `${(tv(b) / timelineMax) * 100}%`, opacity: hover === null || hover === i ? 1 : 0.45 }} />
                  </div>
                ))}
              </div>
              {hover !== null && data.timeline[hover] && (
                <div className="dash-tip" style={{ left: `${((hover + 0.5) / data.timeline.length) * 100}%` }}>
                  <b>{data.period.unit === 'day' ? fmtDate(data.timeline[hover].date, 'day') : data.period.unit === 'week' ? `Week of ${fmtDate(data.timeline[hover].date, 'day')}` : fmtDate(data.timeline[hover].date, 'month')}</b>
                  <div>{km(data.timeline[hover].km)} km · {nf.format(data.timeline[hover].trips)} trips</div>
                  <div>{data.timeline[hover].drivers} drivers · {hours(data.timeline[hover].workMs)} h</div>
                </div>
              )}
            </div>
            <div className="dash-axis">
              {data.timeline.map((b, i) => {
                const every = Math.ceil(data.timeline.length / 8);
                return <span key={b.date}>{i % every === 0 ? fmtDate(b.date, data.period.unit) : ''}</span>;
              })}
            </div>
          </div>

          <div className="dash-three">
            <Breakdown title="By project" rows={data.byProject} measure={measure} selected={filter.projectId} onPick={(k) => toggle('projectId', k)} />
            <Breakdown title="By region" rows={data.byRegion} measure={measure} selected={filter.region} onPick={(k) => toggle('region', k)} />
            <Breakdown title="By country" rows={data.byCountry} measure={measure} selected={filter.country} onPick={(k) => toggle('country', k)} />
          </div>

          <div className="card list-card dash-table">
            <div className="dash-card-head" style={{ padding: '12px 16px 4px' }}><h3>Projects in detail</h3><span className="muted">click a row to filter by it</span></div>
            <table>
              <thead>
                <tr>
                  <th>Project</th><th>Drivers</th><th>Active</th><th>Driving</th><th>Trips</th><th>Km driven</th>
                  <th>Km / driver</th><th>Working hours</th><th>UKM</th><th>Assigned UKM</th><th>Outside UKM</th><th>Markers</th>
                </tr>
              </thead>
              <tbody>
                {data.byProject.map((r) => (
                  <tr key={r.key} className={filter.projectId === r.key ? 'sel' : ''} onClick={() => toggle('projectId', r.key)} style={{ cursor: 'pointer' }}>
                    <td style={{ fontWeight: 700 }}>{r.name}</td>
                    <td>{nf.format(r.drivers)}</td><td>{nf.format(r.activeDrivers)}</td><td>{nf.format(r.drivingDrivers)}</td>
                    <td>{nf.format(r.trips)}</td><td style={{ fontWeight: 700 }}>{km(r.km)}</td>
                    <td>{r.drivingDrivers ? km(r.km / r.drivingDrivers) : '—'}</td><td>{hours(r.workMs)}</td>
                    <td>{km(r.ukm)}</td><td>{km(r.assignedUkm)}</td><td>{km(r.outsideUkm)}</td><td>{nf.format(r.markers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card list-card dash-table">
            <div className="dash-card-head" style={{ padding: '12px 16px 4px' }}><h3>Top drivers by km</h3><span className="muted">in this period, with the filters above</span></div>
            <table>
              <thead>
                <tr><th>#</th><th>Driver</th><th>Project</th><th>Country</th><th>Days driven</th><th>Trips</th><th>Km driven</th><th>UKM</th><th>Working hours</th></tr>
              </thead>
              <tbody>
                {data.topDrivers.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No driving in this period.</td></tr>}
                {data.topDrivers.map((d, i) => (
                  <tr key={d.driverId}>
                    <td className="muted">{i + 1}</td>
                    <td style={{ fontWeight: 700 }}>{d.name}{!d.active && <span className="badge gray" style={{ marginLeft: 6 }}>exited</span>}</td>
                    <td>{d.project ?? '—'}</td><td>{d.country}</td><td>{d.days}</td><td>{nf.format(d.trips)}</td>
                    <td style={{ fontWeight: 700 }}>{km(d.km)}</td><td>{km(d.ukm)}</td><td>{hours(d.workMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Breakdown({ title, rows, measure, selected, onPick }: {
  title: string; rows: Row[]; measure: Measure; selected?: string; onPick: (key: string) => void;
}) {
  const sorted = [...rows].sort((a, b) => b[measure] - a[measure] || a.name.localeCompare(b.name));
  const max = Math.max(1, ...sorted.map((r) => r[measure]));
  const total = sorted.reduce((a, r) => a + r[measure], 0);
  return (
    <div className="card dash-card">
      <div className="dash-card-head"><h3>{title}</h3><span className="muted">click to filter</span></div>
      {sorted.length === 0 && <div className="muted" style={{ padding: '18px 0' }}>Nothing in this period.</div>}
      <div className="dash-bars">
        {sorted.map((r) => {
          const on = selected === r.key;
          const dim = Boolean(selected) && !on;
          return (
            <button key={r.key} className={`dash-bar${on ? ' on' : ''}`} onClick={() => onPick(r.key)}
              title={`${r.name}: ${fmt(measure, r[measure])}${total ? ` (${Math.round((r[measure] / total) * 100)}%)` : ''} · ${r.drivers} drivers (${r.activeDrivers} active) · ${nf.format(r.trips)} trips · ${km(r.km)} km · ${hours(r.workMs)} h`}>
              <span className="name">{r.name}</span>
              <span className="track"><span className="fill" style={{ width: `${(r[measure] / max) * 100}%`, opacity: dim ? 0.35 : 1 }} /></span>
              <span className="val">{fmt(measure, r[measure])}</span>
              <span className="sub">{r.drivers} drivers · {nf.format(r.trips)} trips</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const STYLE = `
.dash { --dash-blue: ${BLUE}; }
.dash-body { overflow: auto; display: flex; flex-direction: column; gap: 14px; padding-bottom: 24px; }
.dash-seg, .dash-measure { display: inline-flex; gap: 4px; padding: 4px; border-radius: 11px; background: #e9edf5; flex-wrap: wrap; }
.dash-seg button, .dash-measure button { border: 0; background: transparent; padding: 6px 12px; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; color: var(--text-2); cursor: pointer; }
.dash-seg button.on, .dash-measure button.on { background: #fff; color: var(--brand); box-shadow: 0 1px 4px #19243b14; }
.dash-measure { align-self: flex-start; align-items: center; }
.dash-measure > span { font-size: 12px; font-weight: 700; color: var(--muted); padding: 0 6px 0 8px; text-transform: uppercase; letter-spacing: .4px; }
.dash-range { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.dash-range .input { width: 150px; padding: 6px 8px; }
.dash-filters { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.dash-filters button { border: 1px solid #b9d3f3; background: #eff6ff; color: var(--brand); border-radius: 99px; padding: 5px 11px; font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
.dash-filters button.clear { background: #fff; border-color: var(--line-2); color: var(--text-2); }
.dash-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.dash-kpi { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 13px 15px; }
.dash-kpi .k { font-size: 11.5px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
.dash-kpi .v { font-size: 26px; font-weight: 800; color: var(--text); letter-spacing: -.5px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.dash-kpi .v small { font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
.dash-kpi .s { font-size: 12px; color: var(--muted); margin-top: 3px; }
.dash-delta { font-weight: 700; }
.dash-delta.up { color: #047857; } .dash-delta.down { color: #b91c1c; } .dash-delta.flat { color: var(--muted); }
.dash-card { padding: 14px 16px; }
.dash-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.dash-card-head h3 { margin: 0; font-size: 15px; }
.dash-card-head .muted { font-size: 12px; }
.dash-timeline { position: relative; height: 200px; margin-left: 64px; }
.dash-grid > div { position: absolute; left: 0; right: 0; border-top: 1px solid #eef1f6; }
.dash-grid span { position: absolute; right: 100%; transform: translateY(-50%); margin-right: 8px; font-size: 11px; color: var(--muted); white-space: nowrap; }
.dash-cols { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 2px; }
.dash-col { flex: 1; height: 100%; display: flex; align-items: flex-end; cursor: default; }
.dash-col .bar { width: 100%; min-height: 0; background: var(--dash-blue); border-radius: 4px 4px 0 0; transition: opacity .12s; }
.dash-tip { position: absolute; top: 4px; transform: translateX(-50%); background: #0f172a; color: #fff; border-radius: 8px; padding: 7px 10px; font-size: 12px; pointer-events: none; white-space: nowrap; z-index: 2; }
.dash-axis { display: flex; gap: 2px; margin-left: 64px; margin-top: 6px; }
.dash-axis span { flex: 1; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: visible; }
.dash-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
@media (max-width: 1100px) { .dash-three { grid-template-columns: 1fr; } }
.dash-bars { display: flex; flex-direction: column; gap: 4px; max-height: 340px; overflow: auto; }
.dash-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name val" "track track" "sub sub"; gap: 3px 8px; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 10px; padding: 7px 8px; font: inherit; cursor: pointer; }
.dash-bar:hover { background: #f5f8fd; }
.dash-bar.on { border-color: #b9d3f3; background: #eff6ff; }
.dash-bar .name { grid-area: name; font-size: 13px; font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-bar .val { grid-area: val; font-size: 13px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.dash-bar .track { grid-area: track; height: 8px; background: #eef1f6; border-radius: 99px; overflow: hidden; }
.dash-bar .fill { display: block; height: 100%; background: var(--dash-blue); border-radius: 99px; }
.dash-bar .sub { grid-area: sub; font-size: 11.5px; color: var(--muted); }
.dash-table { max-height: none; }
.dash-table tr.sel td { background: #eff6ff; }
`;
