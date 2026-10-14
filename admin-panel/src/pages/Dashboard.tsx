import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { divIcon, latLngBounds } from 'leaflet';
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { MapAutoResize } from '../lib/MapAutoResize';
import { PageIcon } from '../components/AppIcon';
import { api, viewerTimeZone } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isAdminRole } from '../lib/types';

/**
 * The admin dashboard (admins and superadmins): kilometres and UKM, by project and region, day by
 * day, week by week or month by month.
 *
 * One request (GET /api/analytics/overview) carries everything. Every table adds up to the totals.
 * Picking a project or region filters the whole page; its own table keeps listing every row, with
 * the picked one highlighted.
 *
 * UKM is the one figure every screen reads (effectiveUkmMeters), split into Assigned (trips on
 * the driver's own polygons) and Free drive (no polygon held). Outside UKM — first-driven
 * customer roads outside the driver's polygons — is credit for the project, shown beside UKM and
 * never added to it. Network covered is to date, not limited to the period.
 */

type Fig = { km: number; ukm: number; assignedUkm: number; freeUkm: number; outsideUkm: number };
type Network = { targetMeters: number; coveredMeters: number };
type Row = Fig & { key: string; name: string; drivers: number; series: { km: number; ukm: number }[]; network: Network };
type Grain = 'day' | 'week' | 'month';
type LiveCar = { region: string; lat: number; lon: number; at: string | null; driver: string; plate: string | null };
type Overview = {
  period: { from: string; to: string; days: number; grain: Grain; previousFrom: string; previousTo: string };
  totals: Fig & { trips: number; drivers: number; network: Network };
  previous: Fig;
  cars?: { now: number; period: number; live?: LiveCar[]; byRegion: { region: string; now: number; period: number }[] };
  timeline: (Fig & { date: string })[];
  byProject: Row[];
  byRegion: Row[];
  byDriver: (Fig & { driverId: string; name: string; active: boolean; project: string | null; region: string | null; days: number })[];
};

const nf = new Intl.NumberFormat();
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
/** Metres → km: one decimal under 10 km, whole numbers above. */
const km = (m: number) => (m > 0 && m < 10000 ? nf1.format(m / 1000) : nf.format(Math.round(m / 1000)));
const pct = (a: number, b: number) => (b > 0 ? `${nf1.format((a / b) * 100)}%` : '—');

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const monday = (weeksBack: number) => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - weeksBack * 7);
  return iso(d);
};
const monthStart = (monthsBack: number) => { const d = new Date(); return iso(new Date(d.getFullYear(), d.getMonth() - monthsBack, 1)); };
const monthEnd = (monthsBack: number) => { const d = new Date(); return iso(new Date(d.getFullYear(), d.getMonth() - monthsBack + 1, 0)); };

/** Ranges; each grain opens on the one that reads best in it. */
const RANGES: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'thisWeek', label: 'This week', range: () => [monday(0), today()] },
  { key: 'lastWeek', label: 'Last week', range: () => [monday(1), daysAgo(((new Date().getDay() + 6) % 7) + 1)] },
  { key: 'd30', label: 'Last 30 days', range: () => [daysAgo(29), today()] },
  { key: 'w4', label: 'Last 4 weeks', range: () => [monday(3), today()] },
  { key: 'w12', label: 'Last 12 weeks', range: () => [monday(11), today()] },
  { key: 'thisMonth', label: 'This month', range: () => [monthStart(0), today()] },
  { key: 'lastMonth', label: 'Last month', range: () => [monthStart(1), monthEnd(1)] },
  { key: 'm3', label: 'Last 3 months', range: () => [monthStart(2), today()] },
  { key: 'm6', label: 'Last 6 months', range: () => [monthStart(5), today()] },
  { key: 'm12', label: 'Last 12 months', range: () => [monthStart(11), today()] },
  { key: 'year', label: 'This year', range: () => [`${new Date().getFullYear()}-01-01`, today()] },
  { key: 'all', label: 'All time', range: () => ['2025-01-01', today()] },
];
const GRAINS: { key: Grain; label: string; range: string }[] = [
  { key: 'day', label: 'Daily', range: 'd30' },
  { key: 'week', label: 'Weekly', range: 'w12' },
  { key: 'month', label: 'Monthly', range: 'm12' },
];
const rangeOf = (key: string) => RANGES.find((r) => r.key === key)!.range();

const fmtBucket = (s: string, g: Grain, long = false) => {
  const d = new Date(`${s}T00:00:00`);
  if (g === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: long ? 'numeric' : '2-digit' });
  const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return g === 'week' && long ? `Week of ${day}` : day;
};
const grainWord = (g: Grain) => (g === 'day' ? 'day' : g === 'week' ? 'week' : 'month');

function Delta({ now, before }: { now: number; before: number }) {
  if (!before && !now) return <span className="dash-delta flat">—</span>;
  if (!before) return <span className="dash-delta flat">nothing the period before</span>;
  const p = Math.round(((now - before) / before) * 100);
  if (p === 0) return <span className="dash-delta flat">no change</span>;
  // Against a near-empty period before, a percentage is noise ("▲ 225748%"); say it plainly.
  if (p > 999) return <span className="dash-delta up">▲ over 10×</span>;
  return <span className={`dash-delta ${p > 0 ? 'up' : 'down'}`}>{p > 0 ? '▲' : '▼'} {Math.abs(p)}%</span>;
}

function Covered({ n }: { n: Network }) {
  if (!n.targetMeters) return <span className="muted">no network</span>;
  const f = Math.min(1, n.coveredMeters / n.targetMeters);
  return (
    <span className="dash-cov" title={`${km(n.coveredMeters)} of ${km(n.targetMeters)} km driven to date`}>
      <span className="track"><span className="fill" style={{ width: `${f * 100}%` }} /></span>
      <b>{pct(n.coveredMeters, n.targetMeters)}</b>
      <span className="muted">{km(n.coveredMeters)} / {km(n.targetMeters)} km</span>
    </span>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  const [grain, setGrain] = useState<Grain>('week');
  const [rangeKey, setRangeKey] = useState('w12');
  const [[from, to], setRange] = useState<[string, string]>(() => rangeOf('w12'));
  const [filter, setFilter] = useState<{ projectId?: string; region?: string }>({});
  const [pivot, setPivot] = useState<'km' | 'ukm'>('km');
  const [pivotBy, setPivotBy] = useState<'project' | 'region'>('project');
  const [allDrivers, setAllDrivers] = useState(false);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // A minute's tick keeps "on the road now" current; the refresh it causes is silent.
  const [tick, setTick] = useState(0);
  const lastQuery = useRef('');
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') setTick((n) => n + 1); }, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!isAdminRole(user?.role)) return;
    const q = new URLSearchParams({ from, to, grain, tz: viewerTimeZone() });
    if (filter.projectId) q.set('projectId', filter.projectId);
    if (filter.region) q.set('region', filter.region);
    const silent = lastQuery.current === q.toString();
    lastQuery.current = q.toString();
    if (!silent) setLoading(true);
    api.get<Overview>(`/api/analytics/overview?${q}`)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => { if (!silent) setError(e instanceof Error ? e.message : 'Could not load the dashboard'); })
      .finally(() => { if (!silent) setLoading(false); });
  }, [user?.role, from, to, grain, filter, tick]);

  const pickGrain = (g: Grain) => {
    setGrain(g);
    const r = GRAINS.find((x) => x.key === g)!.range;
    setRangeKey(r);
    setRange(rangeOf(r));
  };
  const toggle = (dim: 'projectId' | 'region', key: string) =>
    setFilter((f) => ({ ...f, [dim]: f[dim] === key ? undefined : key }));

  const projects = useMemo(() => (data ? [...data.byProject].sort((a, b) => a.name.localeCompare(b.name)) : []), [data]);
  const regions = useMemo(() => (data ? data.byRegion.map((r) => r.key) : []), [data]);

  if (user && !isAdminRole(user.role)) return <Navigate to="/" replace />;

  const t = data?.totals;
  const p = data?.previous;
  const g = data?.period.grain ?? grain;
  const max = data ? Math.max(1, ...data.timeline.map((b) => Math.max(b.km, b.ukm))) : 1;
  const pivotRows = data ? (pivotBy === 'project' ? data.byProject : data.byRegion).filter((r) => r.km > 0) : [];
  const pivotMax = Math.max(1, ...pivotRows.flatMap((r) => r.series.map((s) => s[pivot])));
  // One colour per region, the same on the map and its tile; sorted so a region keeps its colour.
  const regionColor = (r: string) => {
    const names = [...new Set((data?.cars?.byRegion ?? []).map((x) => x.region))].sort();
    return REGION_COLORS[Math.max(0, names.indexOf(r)) % REGION_COLORS.length];
  };
  const drivers = data ? (allDrivers ? data.byDriver : data.byDriver.slice(0, 15)) : [];

  return (
    <div className="list-page dash">
      <style>{STYLE}</style>
      <div className="dr-bar dash-head">
        <h1 className="dr-title"><PageIcon name="dashboard" />Dashboard</h1>
        {/* Every control on one line: grain, period, dates, project, region. */}
        <div className="dash-controls">
          <div className="dash-seg" role="group" aria-label="Show by">
            {GRAINS.map((x) => (
              <button key={x.key} className={grain === x.key ? 'on' : ''} onClick={() => pickGrain(x.key)}>{x.label}</button>
            ))}
          </div>
          <select className="input" value={rangeKey} aria-label="Period"
            onChange={(e) => { if (e.target.value === 'custom') { setRangeKey('custom'); return; } setRangeKey(e.target.value); setRange(rangeOf(e.target.value)); }}>
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            <option value="custom">Custom dates…</option>
          </select>
          <span className="dash-range">
            <input className="input" type="date" value={from} max={to} aria-label="From"
              onChange={(e) => { setRangeKey('custom'); setRange([e.target.value, to]); }} />
            <span>to</span>
            <input className="input" type="date" value={to} min={from} aria-label="To"
              onChange={(e) => { setRangeKey('custom'); setRange([from, e.target.value]); }} />
          </span>
          <select className={`input dash-pick${filter.projectId ? ' on' : ''}`} value={filter.projectId ?? ''} aria-label="Project"
            onChange={(e) => setFilter((f) => ({ ...f, projectId: e.target.value || undefined }))}>
            <option value="">All projects</option>
            {projects.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
          <select className={`input dash-pick${filter.region ? ' on' : ''}`} value={filter.region ?? ''} aria-label="Region"
            onChange={(e) => setFilter((f) => ({ ...f, region: e.target.value || undefined }))}>
            <option value="">All regions</option>
            {/* The picked region stays listed even when another filter leaves it no driving. */}
            {(filter.region && !regions.includes(filter.region) ? [filter.region, ...regions] : regions).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {(filter.projectId || filter.region) && <button className="dash-clear" onClick={() => setFilter({})}>Clear</button>}
          {loading && <span className="muted" style={{ fontSize: 12.5 }}>Updating…</span>}
        </div>
      </div>

      {error && <div className="card" style={{ color: 'var(--red)', padding: 16 }}>{error}</div>}

      {data && t && p && (
        <div className="dash-body">
          <div className="dash-kpis">
            <div className="dash-kpi">
              <div className="k">Km driven</div>
              <div className="v">{km(t.km)}<small> km</small></div>
              <div className="s"><Delta now={t.km} before={p.km} /> vs previous {data.period.days} days</div>
            </div>
            <div className="dash-kpi hero">
              <div className="k">UKM</div>
              <div className="v">{km(t.ukm)}<small> km</small></div>
              <div className="s"><Delta now={t.ukm} before={p.ukm} /> · {pct(t.ukm, t.km)} of km was new road</div>
            </div>
            <div className="dash-kpi">
              <div className="k">Assigned UKM</div>
              <div className="v">{km(t.assignedUkm)}<small> km</small></div>
              <div className="s">in drivers' own polygons{t.outsideUkm > 0 && <> · +{km(t.outsideUkm)} km outside them</>}</div>
            </div>
            <div className="dash-kpi">
              <div className="k">Free-drive UKM</div>
              <div className="v">{km(t.freeUkm)}<small> km</small></div>
              <div className="s">trips with no polygon held</div>
            </div>
            <div className="dash-kpi">
              <div className="k">Network covered</div>
              <div className="v">{t.network.targetMeters ? pct(t.network.coveredMeters, t.network.targetMeters) : '—'}</div>
              <div className="s">{km(t.network.coveredMeters)} of {km(t.network.targetMeters)} km, to date</div>
            </div>
          </div>

          {/* An API from before this card sends no cars — leave the card out rather than break the page. */}
          {data.cars && <div className="card dash-card">
            <div className="dash-card-head">
              <h3>Active cars by region</h3>
              <span className="muted">regions with a car on the road now, updated every minute — click one to filter by it</span>
            </div>
            <div className="dash-cars">
              <div className="dash-car total">
                <div className="r">{filter.region ?? 'All regions'}</div>
                <div className="n"><i className={data.cars.now ? 'live' : ''} />{nf.format(data.cars.now)}<small> on the road now</small></div>
                <div className="p">{nf.format(data.cars.period)} drove in this period</div>
              </div>
              {/* Only regions with a car out right now; a region with none drops out until one is. */}
              {!data.cars.byRegion.some((r) => r.now > 0) && <div className="muted" style={{ alignSelf: 'center', fontSize: 13 }}>No car is on the road right now.</div>}
              {data.cars.byRegion.filter((r) => r.now > 0).map((r) => (
                <button key={r.region} className={`dash-car${filter.region === r.region ? ' sel' : filter.region ? ' dim' : ''}`}
                  onClick={() => toggle('region', r.region)}>
                  <div className="r"><span className="sw" style={{ background: regionColor(r.region) }} />{r.region}</div>
                  <div className="n"><i className={r.now ? 'live' : ''} />{nf.format(r.now)}<small> now</small></div>
                  <div className="p">{nf.format(r.period)} drove in this period</div>
                </button>
              ))}
            </div>
            {(data.cars.live?.length ?? 0) > 0 && (
              <CarsMap cars={data.cars.live!} colorOf={regionColor} selected={filter.region} onPick={(r) => toggle('region', r)} />
            )}
          </div>}

          <div className="card dash-card">
            <div className="dash-card-head">
              <h3>Km and UKM by {grainWord(g)}</h3>
              <span className="dash-legend"><i className="km" />Km driven <i className="ukm" />UKM</span>
            </div>
            {grain !== g && <div className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 8 }}>Too many {grainWord(grain)}s for this period — shown by {grainWord(g)}.</div>}
            <div className="dash-timeline" onMouseLeave={() => setHover(null)}>
              <div className="dash-grid">
                {[1, 0.5, 0].map((f) => <div key={f} style={{ bottom: `${f * 100}%` }}><span>{km(max * f)} km</span></div>)}
              </div>
              <div className="dash-cols">
                {data.timeline.map((b, i) => (
                  <div key={b.date} className="dash-col" onMouseEnter={() => setHover(i)} style={{ opacity: hover === null || hover === i ? 1 : 0.5 }}>
                    <div className="bar km" style={{ height: `${(b.km / max) * 100}%` }} />
                    <div className="bar ukm" style={{ height: `${(b.ukm / max) * 100}%` }} />
                  </div>
                ))}
              </div>
              {hover !== null && data.timeline[hover] && (() => {
                const b = data.timeline[hover];
                const left = ((hover + 0.5) / data.timeline.length) * 100;
                return (
                  <div className="dash-tip" style={{ left: `${Math.min(85, Math.max(15, left))}%` }}>
                    <b>{fmtBucket(b.date, g, true)}</b>
                    <div>{km(b.km)} km driven</div>
                    <div>{km(b.ukm)} km UKM ({pct(b.ukm, b.km)})</div>
                    <div className="muted2">{km(b.assignedUkm)} assigned · {km(b.freeUkm)} free drive</div>
                  </div>
                );
              })()}
            </div>
            <div className="dash-axis">
              {data.timeline.map((b, i) => {
                const every = Math.ceil(data.timeline.length / 10);
                return <span key={b.date}>{i % every === 0 ? fmtBucket(b.date, g) : ''}</span>;
              })}
            </div>
          </div>

          <FigTable title="By project" first="Project" rows={data.byProject} selected={filter.projectId}
            onPick={(k) => toggle('projectId', k)} totals={t} />
          <FigTable title="By region" first="Region" rows={data.byRegion} selected={filter.region}
            onPick={(k) => toggle('region', k)} totals={t} />

          <div className="card list-card dash-table">
            <div className="dash-card-head" style={{ padding: '12px 16px 4px' }}>
              <h3>{pivotBy === 'project' ? 'Projects' : 'Regions'} {grainWord(g)} by {grainWord(g)}</h3>
              <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="dash-seg small">
                  <button className={pivotBy === 'project' ? 'on' : ''} onClick={() => setPivotBy('project')}>Projects</button>
                  <button className={pivotBy === 'region' ? 'on' : ''} onClick={() => setPivotBy('region')}>Regions</button>
                </span>
                <span className="dash-seg small">
                  <button className={pivot === 'km' ? 'on' : ''} onClick={() => setPivot('km')}>Km</button>
                  <button className={pivot === 'ukm' ? 'on' : ''} onClick={() => setPivot('ukm')}>UKM</button>
                </span>
              </span>
            </div>
            <div className="dash-scroll">
              <table className="dash-pivot">
                <thead>
                  <tr>
                    <th>{pivotBy === 'project' ? 'Project' : 'Region'}</th>
                    {data.timeline.map((b) => <th key={b.date}>{fmtBucket(b.date, g)}</th>)}
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {pivotRows.length === 0 && <tr><td colSpan={data.timeline.length + 2} className="muted" style={{ textAlign: 'center', padding: 24 }}>No driving in this period.</td></tr>}
                  {pivotRows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ fontWeight: 700 }}>{r.name}</td>
                      {r.series.map((s, i) => (
                        <td key={i} style={{ background: s[pivot] ? `rgba(42,120,214,${0.08 + 0.5 * (s[pivot] / pivotMax)})` : undefined }}>
                          {s[pivot] ? km(s[pivot]) : <span className="muted">·</span>}
                        </td>
                      ))}
                      <td style={{ fontWeight: 700 }}>{km(r[pivot])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card list-card dash-table">
            <div className="dash-card-head" style={{ padding: '12px 16px 4px' }}>
              <h3>Drivers</h3>
              <span className="muted">{nf.format(data.byDriver.length)} drove in this period, with the filters above</span>
            </div>
            <div className="dash-scroll">
              <table>
                <thead>
                  <tr><th>#</th><th>Driver</th><th>Project</th><th>Region</th><th>Days</th><th>Km driven</th><th>UKM</th><th>Assigned</th><th>Free drive</th><th>UKM % of km</th></tr>
                </thead>
                <tbody>
                  {drivers.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>No driving in this period.</td></tr>}
                  {drivers.map((d, i) => (
                    <tr key={d.driverId}>
                      <td className="muted">{i + 1}</td>
                      <td style={{ fontWeight: 700 }}>{d.name}{!d.active && <span className="badge gray" style={{ marginLeft: 6 }}>exited</span>}</td>
                      <td>{d.project ?? '—'}</td><td>{d.region ?? '—'}</td><td>{d.days}</td>
                      <td style={{ fontWeight: 700 }}>{km(d.km)}</td><td style={{ fontWeight: 700 }}>{km(d.ukm)}</td>
                      <td>{km(d.assignedUkm)}</td><td>{km(d.freeUkm)}</td><td>{pct(d.ukm, d.km)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.byDriver.length > 15 && (
              <button className="dash-more" onClick={() => setAllDrivers((v) => !v)}>
                {allDrivers ? 'Show top 15' : `Show all ${data.byDriver.length} drivers`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const REGION_COLORS = ['#2a78d6', '#16a34a', '#d97706', '#9333ea', '#db2777', '#0891b2', '#65a30d', '#dc2626'];
const ZOOMED_IN = 8;

/**
 * The cars on the road, on a map. Zoomed out, each region is one bubble with its count (a click
 * filters the page by it); zoomed in, each car is a dot with its driver and plate. The map fits
 * the cars — or the picked region's — when that set of regions changes, not on every minute's
 * refresh, so it does not snap back while someone is panning.
 */
function CarsMap({ cars, colorOf, selected, onPick }: {
  cars: LiveCar[]; colorOf: (r: string) => string; selected?: string; onPick: (r: string) => void;
}) {
  const [zoom, setZoom] = useState(3);
  const regions = useMemo(() => {
    const m = new Map<string, LiveCar[]>();
    for (const c of cars) m.set(c.region, [...(m.get(c.region) ?? []), c]);
    return [...m.entries()].map(([region, list]) => ({
      region,
      count: list.length,
      lat: list.reduce((s, c) => s + c.lat, 0) / list.length,
      lon: list.reduce((s, c) => s + c.lon, 0) / list.length,
    }));
  }, [cars]);
  const shown = selected && cars.some((c) => c.region === selected) ? cars.filter((c) => c.region === selected) : cars;
  const fitKey = `${selected ?? ''}|${regions.map((r) => r.region).sort().join(',')}`;

  return (
    <div className="dash-carmap">
      <MapContainer center={[shown[0].lat, shown[0].lon]} zoom={3} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
        <MapAutoResize />
        <FitCars cars={shown} fitKey={fitKey} />
        <ZoomWatch onZoom={setZoom} />
        {zoom < ZOOMED_IN
          ? regions.map((r) => (
            <Marker key={r.region} position={[r.lat, r.lon]} eventHandlers={{ click: () => onPick(r.region) }}
              opacity={selected && selected !== r.region ? 0.45 : 1}
              icon={divIcon({
                className: '',
                iconSize: [0, 0],
                html: `<div class="dash-bubble" style="background:${colorOf(r.region)}">${r.count}</div>`,
              })}>
              <Tooltip direction="top" offset={[0, -16]}>{r.region}: {r.count} on the road now</Tooltip>
            </Marker>
          ))
          : cars.map((c, i) => (
            <CircleMarker key={`${c.driver}-${i}`} center={[c.lat, c.lon]} radius={7}
              pathOptions={{ color: '#fff', weight: 2, fillColor: colorOf(c.region), fillOpacity: 1 }}>
              <Tooltip direction="top" offset={[0, -6]}>
                <b>{c.driver}</b>{c.plate ? ` · ${c.plate}` : ''}<br />{c.region}
                {c.at ? ` · last fix ${new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
              </Tooltip>
            </CircleMarker>
          ))}
      </MapContainer>
    </div>
  );
}

function FitCars({ cars, fitKey }: { cars: LiveCar[]; fitKey: string }) {
  const map = useMap();
  useEffect(() => {
    if (!cars.length) return;
    map.fitBounds(latLngBounds(cars.map((c) => [c.lat, c.lon] as [number, number])), { padding: [40, 40], maxZoom: 12 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);
  return null;
}

function ZoomWatch({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => onZoom(map.getZoom()), [map, onZoom]);
  return null;
}

function FigTable({ title, first, rows, selected, onPick, totals }: {
  title: string; first: string; rows: Row[]; selected?: string; onPick: (key: string) => void; totals: Overview['totals'];
}) {
  const maxKm = Math.max(1, ...rows.map((r) => r.km));
  return (
    <div className="card list-card dash-table">
      <div className="dash-card-head" style={{ padding: '12px 16px 4px' }}><h3>{title}</h3><span className="muted">click a row to filter by it</span></div>
      <div className="dash-scroll">
        <table>
          <thead>
            <tr>
              <th>{first}</th><th>Km driven</th><th>UKM</th><th>Assigned UKM</th><th>Free-drive UKM</th>
              <th title="First-driven customer roads outside the driver's own polygons — credit for the project, not in UKM">Outside UKM</th>
              <th>UKM % of km</th><th>Drivers</th><th>Network covered (to date)</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>Nothing in this period.</td></tr>}
            {rows.map((r) => (
              <tr key={r.key} className={selected === r.key ? 'sel' : selected ? 'dim' : ''} onClick={() => onPick(r.key)} style={{ cursor: 'pointer' }}>
                <td style={{ fontWeight: 700 }}>{r.name}</td>
                <td>
                  <span className="dash-kmcell">
                    <span className="track"><span className="fill" style={{ width: `${(r.km / maxKm) * 100}%` }} /></span>
                    <b>{km(r.km)}</b>
                  </span>
                </td>
                <td style={{ fontWeight: 700 }}>{km(r.ukm)}</td>
                <td>{km(r.assignedUkm)}</td><td>{km(r.freeUkm)}</td><td className="muted">{km(r.outsideUkm)}</td>
                <td>{pct(r.ukm, r.km)}</td><td>{nf.format(r.drivers)}</td>
                <td><Covered n={r.network} /></td>
              </tr>
            ))}
          </tbody>
          {!selected && rows.length > 1 && (
            <tfoot>
              <tr>
                <td>Total</td><td>{km(totals.km)}</td><td>{km(totals.ukm)}</td><td>{km(totals.assignedUkm)}</td>
                <td>{km(totals.freeUkm)}</td><td>{km(totals.outsideUkm)}</td><td>{pct(totals.ukm, totals.km)}</td>
                <td>{nf.format(totals.drivers)}</td><td><Covered n={totals.network} /></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

const STYLE = `
.dash { --dash-blue: #2a78d6; --dash-light: #b9d3f3; }
.dash-body { overflow: auto; display: flex; flex-direction: column; gap: 14px; padding-bottom: 24px; }
.dash-seg { display: inline-flex; gap: 4px; padding: 4px; border-radius: 11px; background: #e9edf5; flex-wrap: wrap; }
.dash-seg button { border: 0; background: transparent; padding: 6px 12px; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; color: var(--text-2); cursor: pointer; }
.dash-seg button.on { background: #fff; color: var(--brand); box-shadow: 0 1px 4px #19243b14; }
.dash-controls .dash-seg { flex-wrap: nowrap; padding: 3px; } .dash-controls .dash-seg button { padding: 5px 11px; }
.dash-seg.small { padding: 3px; } .dash-seg.small button { padding: 4px 10px; font-size: 12px; }
.dash-head { gap: 8px 16px; }
/* One line, always: the row drops below the title as a whole rather than breaking apart, and
   scrolls sideways only on a screen narrower than the row itself. select.input is width:100%
   globally, hence the two-class selectors. */
.dash-controls { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; max-width: 100%; overflow-x: auto; padding: 2px 0; }
.dash-controls > * { flex: 0 0 auto; }
.dash-controls select.input, .dash-controls .input { width: auto; height: 34px; padding: 4px 28px 4px 10px; font-size: 13px; line-height: 1.2; }
.dash-controls input.input { padding: 4px 8px; width: 132px; }
.dash-controls select.dash-pick { max-width: 210px; text-overflow: ellipsis; }
.dash-controls select.dash-pick.on { border-color: var(--brand); color: var(--brand); font-weight: 700; background-color: #eff6ff; }
.dash-range { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.dash-clear { border: 0; background: none; color: var(--brand); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; padding: 0 4px; }
.dash-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
.dash-kpi { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 13px 15px; }
.dash-kpi.hero { border-color: #b9d3f3; background: #f5f9ff; }
.dash-kpi .k { font-size: 11.5px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
.dash-kpi .v { font-size: 26px; font-weight: 800; color: var(--text); letter-spacing: -.5px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.dash-kpi .v small { font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
.dash-kpi .s { font-size: 12px; color: var(--muted); margin-top: 3px; }
.dash-delta { font-weight: 700; }
.dash-delta.up { color: #047857; } .dash-delta.down { color: #b91c1c; } .dash-delta.flat { color: var(--muted); }
.dash-card { padding: 14px 16px; }
.dash-cars { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.dash-car { text-align: left; font: inherit; color: inherit; background: #f8fafc; border: 1px solid var(--line); border-radius: 12px; padding: 11px 13px; cursor: pointer; transition: opacity .12s; }
.dash-car.total { background: #f5f9ff; border-color: #b9d3f3; cursor: default; }
.dash-car.sel { border-color: var(--brand); background: #eff6ff; } .dash-car.dim { opacity: .6; }
.dash-car .r { font-size: 12px; font-weight: 700; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dash-car .n { display: flex; align-items: baseline; gap: 6px; font-size: 24px; font-weight: 800; letter-spacing: -.5px; margin-top: 3px; font-variant-numeric: tabular-nums; }
.dash-car .n small { font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
.dash-car .n i { width: 9px; height: 9px; border-radius: 50%; background: #cbd5e1; align-self: center; flex: none; }
.dash-car .n i.live { background: #16a34a; box-shadow: 0 0 0 3px #16a34a2e; }
.dash-car .r .sw { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 6px; vertical-align: 0; }
.dash-carmap { height: 320px; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); margin-top: 12px; position: relative; z-index: 0; }
.dash-bubble { transform: translate(-50%, -50%); min-width: 34px; height: 34px; padding: 0 8px; border-radius: 99px; color: #fff; font-weight: 800; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; border: 3px solid #fff; box-shadow: 0 2px 8px #0f172a40; cursor: pointer; box-sizing: border-box; }
.dash-car .p { font-size: 12px; color: var(--muted); margin-top: 2px; }
.dash-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.dash-card-head h3 { margin: 0; font-size: 15px; }
.dash-card-head .muted { font-size: 12px; }
.dash-legend { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.dash-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-left: 8px; }
.dash-legend i.km { background: var(--dash-light); } .dash-legend i.ukm { background: var(--dash-blue); }
.dash-timeline { position: relative; height: 220px; margin-left: 70px; }
.dash-grid > div { position: absolute; left: 0; right: 0; border-top: 1px solid #eef1f6; }
.dash-grid span { position: absolute; right: 100%; transform: translateY(-50%); margin-right: 8px; font-size: 11px; color: var(--muted); white-space: nowrap; }
.dash-cols { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 3px; }
.dash-col { flex: 1; height: 100%; position: relative; transition: opacity .12s; }
.dash-col .bar { position: absolute; bottom: 0; border-radius: 4px 4px 0 0; }
.dash-col .bar.km { left: 0; right: 0; background: var(--dash-light); }
.dash-col .bar.ukm { left: 22%; right: 22%; background: var(--dash-blue); }
.dash-tip { position: absolute; top: 4px; transform: translateX(-50%); background: #0f172a; color: #fff; border-radius: 8px; padding: 7px 10px; font-size: 12px; pointer-events: none; white-space: nowrap; z-index: 2; }
.dash-tip .muted2 { color: #cbd5e1; }
.dash-axis { display: flex; gap: 3px; margin-left: 70px; margin-top: 6px; }
.dash-axis span { flex: 1; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: visible; }
.dash-table { max-height: none; flex: none; overflow: visible; }
.dash-scroll { overflow-x: auto; }
.dash-table tr.sel td { background: #eff6ff; }
.dash-table tr.dim td { opacity: .6; }
.dash-table tfoot td { font-weight: 800; border-top: 2px solid var(--line); }
.dash-table td, .dash-table th { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dash-kmcell { display: inline-flex; align-items: center; gap: 8px; }
.dash-kmcell .track, .dash-cov .track { width: 70px; height: 7px; background: #eef1f6; border-radius: 99px; overflow: hidden; display: inline-block; }
.dash-kmcell .fill { display: block; height: 100%; background: var(--dash-light); border-radius: 99px; }
.dash-cov { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; }
.dash-cov .fill { display: block; height: 100%; background: #16a34a; border-radius: 99px; }
.dash-pivot td, .dash-pivot th { text-align: right; }
.dash-pivot td:first-child, .dash-pivot th:first-child { text-align: left; position: sticky; left: 0; background: #fff; z-index: 1; }
.dash-more { margin: 8px 16px 12px; border: 0; background: none; color: var(--brand); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
@media (max-width: 640px) { .dash-timeline, .dash-axis { margin-left: 52px; } .dash-controls input.input { width: 124px; } }
`;
