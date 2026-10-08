import { PageIcon } from '../components/AppIcon';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CoverageMap } from '../components/CoverageMap';
import { Modal } from '../components/Modal';
import { SplitZonesModal } from '../components/SplitZonesModal';
import { ClearCoverageModal } from '../components/ClearCoverageModal';
import { NameDeliveriesModal } from '../components/NameDeliveriesModal';
import { NewImportModal, dropTarget, zipsIn } from '../components/NewImportModal';
import { useProjectScope } from '../components/ProjectSelect';
import { api, uploadRaw } from '../lib/api';
import { PIN_RANK, pinAlpha, statusText, whereText, type DriverPin } from '../lib/driverPins';
import { sessionDt } from '../lib/format';
import { decodePolyline6 } from '../lib/polyline';
import type { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type {
  AreaAssignment,
  AreaCoverageDetail,
  ColumnMapping,
  CoverageArea,
  CoverageSummary,
  DeliveryBreakdown,
  DriverPosition,
  ImportJob,
  ImportReport,
  NetworkVersion,
  Project,
  User,
} from '../lib/types';

/**
 * Coverage — progress against the road network the customer requires us to drive.
 *
 * The distinction from the UKM page matters. UKM measures a driver against themselves: unique
 * kilometres they personally have not repeated, with no denominator, so it can never say how much
 * of the job is left. This page measures the fleet against the customer's own delivery — their
 * work-area polygons and their road links, with their ids — so every number here has a fixed
 * denominator and reconciles against the customer's own file.
 *
 * See backend/src/services/networkImport.js for the import pipeline and
 * backend/src/models/LinkCoverage.js for why the ledger is fleet-wide rather than per driver.
 */

const km = (metres: number) => (metres / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
/** A date input's value, N days from today. Local date parts — a UTC ISO slice shifts the day. */
const isoDay = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** A delivery with no region yet (detection found no positioned area). */
const UNPLACED = 'Not placed';
const regionOf = (v: { region?: string | null }) => v.region || UNPLACED;

/**
 * What a delivery is called in the filter. The customer's import name when it is unique; when two
 * live deliveries share it — three of PRJ-025's do — their size and date, so they can be told apart.
 */
function deliveryNamer(deliveries: NetworkVersion[]) {
  const counts = new Map<string, number>();
  for (const v of deliveries) counts.set(v.label, (counts.get(v.label) || 0) + 1);
  return (v: NetworkVersion) =>
    (counts.get(v.label) || 0) > 1
      ? `${v.label} — ${v.counts.areas.toLocaleString()} areas, ${new Date(v.createdAt).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
        })}`
      : v.label;
}

/** The filter, remembered per project in this browser. Storage can be unavailable; never required. */
const FILTER_KEY = (projectId: string) => `jsan-cov-filter:${projectId}`;
function readFilter(projectId: string): { region: string; delivery: string } {
  try {
    const raw = localStorage.getItem(FILTER_KEY(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    return { region: String(parsed?.region || ''), delivery: String(parsed?.delivery || '') };
  } catch {
    return { region: '', delivery: '' };
  }
}
function writeFilter(projectId: string, value: { region: string; delivery: string }) {
  try {
    localStorage.setItem(FILTER_KEY(projectId), JSON.stringify(value));
  } catch {
    /* private window, blocked storage: the filter just is not remembered */
  }
}

/** The pill on a driver's card: is the drive still open, and if so, what is the vehicle doing. */
const POSITION_PILL: Record<DriverPosition['state'], { tone: string; label: string }> = {
  moving: { tone: 'green', label: 'Driving now' },
  stopped: { tone: 'blue', label: 'Stopped · drive open' },
  stale: { tone: 'amber', label: 'No signal' },
  ended: { tone: 'gray', label: 'Drive ended' },
};
/** A pin for someone the palette has not met — cannot normally happen, must not crash if it does. */
const PIN_FALLBACK: [number, number, number] = [71, 85, 105];

/** HERE functional class, in the customer's terms rather than the number. */
const FUNC_CLASS_LABEL: Record<string, string> = {
  '1': 'FC1 · motorway',
  '2': 'FC2 · highway',
  '3': 'FC3 · arterial',
  '4': 'FC4 · collector',
  '5': 'FC5 · local',
};

const MAPPING_FIELDS: { key: keyof ColumnMapping; label: string; layer: 'boundary' | 'network'; required?: boolean }[] = [
  { key: 'areaCode', label: 'Area code', layer: 'boundary', required: true },
  { key: 'areaName', label: 'Area name', layer: 'boundary' },
  { key: 'areaParent', label: 'Parent region', layer: 'boundary' },
  { key: 'priority', label: 'Priority', layer: 'boundary' },
  { key: 'areaSqm', label: 'Area (m²)', layer: 'boundary' },
  { key: 'linkId', label: 'Link id', layer: 'network', required: true },
  { key: 'linkName', label: 'Street name', layer: 'network' },
  { key: 'funcClass', label: 'Functional class', layer: 'network' },
  { key: 'dirTravel', label: 'Direction of travel', layer: 'network' },
  { key: 'autoAccess', label: 'Car accessible', layer: 'network' },
];

/**
 * Find an area by name and go there.
 *
 * Territory is handed out geographically, and the map spans whole states — a dispatcher who
 * knows the suburb they want ("Gachibowli", "SA2-1") should not have to hunt for its polygon
 * by panning and hovering. Matches name, the customer's code, and the parent region, via the
 * same server search as the areas table, so every area is findable, not just the ones loaded.
 *
 * Keyboard: ↑/↓ to move, Enter to go (the top match when nothing is highlighted), Esc to close.
 */
function AreaSearch({ scopeId, onPick }: { scopeId: string; onPick: (area: CoverageArea) => void }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<CoverageArea[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = text.trim();
    if (!q) { setHits([]); setBusy(false); return; }
    setBusy(true);
    let live = true;
    const t = setTimeout(() => {
      api
        .get<{ areas: CoverageArea[] }>(`/api/network/versions/${scopeId}/areas?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!live) return;
          // Names that START with what was typed first: "Mad" should offer Madhapur before
          // Ward 12 Kamalanagar-Madannapet.
          const lower = q.toLowerCase();
          const rank = (a: CoverageArea) => {
            const n = a.name.toLowerCase();
            const bare = n.replace(/^ward\s+\d+\s+/, '');
            if (bare.startsWith(lower) || n.startsWith(lower) || a.areaCode.toLowerCase() === lower) return 0;
            if (n.includes(lower)) return 1;
            return 2;
          };
          setHits([...r.areas].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 8));
          setActive(0);
        })
        .catch(() => { if (live) setHits([]); })
        .finally(() => { if (live) setBusy(false); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [text, scopeId]);

  // Close when clicking anywhere else on the page.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const go = (a: CoverageArea | undefined) => {
    if (!a) return;
    onPick(a);
    setText(a.name);
    setOpen(false);
  };

  const showList = open && text.trim() !== '';

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        className="input"
        type="search"
        placeholder="Find an area on the map…"
        aria-label="Find an area on the map"
        value={text}
        style={{ width: 230, padding: '4px 10px', fontSize: 12.5 }}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, hits.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); go(hits[active] ?? hits[0]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {showList && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, width: 320,
            background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,.18)', overflow: 'hidden',
          }}
        >
          {busy && hits.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--muted)' }}>Searching…</div>
          )}
          {!busy && hits.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No area matches “{text.trim()}”</div>
          )}
          {hits.map((a, i) => (
            <button
              key={a._id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(a)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px',
                border: 'none', cursor: 'pointer', fontSize: 12.5,
                background: i === active ? 'var(--panel-2)' : 'transparent', color: 'var(--text)',
              }}
            >
              <div style={{ fontWeight: 600 }}>{a.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {a.areaCode}{a.parentName ? ` · ${a.parentName}` : ''}
                {' · '}{a.targetLinks.toLocaleString()} roads
                {a.completed ? ' · completed' : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Bar({ value, total, tone = 'brand' }: { value: number; total: number; tone?: 'brand' | 'green' }) {
  const p = Math.min(100, pct(value, total));
  return (
    <div className="cov-bar" title={`${p.toFixed(1)}%`}>
      <div className={`cov-bar-fill ${tone}`} style={{ width: `${p}%` }} />
    </div>
  );
}

/** A labelled on/off switch — the map's layer list reads as a column of these. */
function Switch({
  checked,
  onChange,
  children,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <label className="cov-switch" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="cov-switch-track" aria-hidden="true"><span className="cov-switch-thumb" /></span>
      <span className="cov-switch-label">{children}</span>
    </label>
  );
}

export function Coverage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'admin' || user?.role === 'manager';

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [versions, setVersions] = useState<NetworkVersion[]>([]);
  const [versionId, setVersionId] = useState('');
  const [tab, setTab] = useState<'progress' | 'imports'>('progress');
  const [error, setError] = useState<string | null>(null);
  /** Region filter: '' = everything. `delivery` narrows further to one delivery in that region. */
  const [filter, setFilter] = useState<{ region: string; delivery: string }>({ region: '', delivery: '' });
  const [naming, setNaming] = useState(false);

  // Each project remembers its own filter.
  useEffect(() => {
    if (projectId) setFilter(readFilter(projectId));
  }, [projectId]);
  const pickFilter = (region: string, delivery = '') => {
    const next = { region, delivery };
    setFilter(next);
    if (projectId) writeFilter(projectId, next);
  };

  // The projects this person may look at — every one for an admin, their own for anyone else
  // (components/ProjectSelect.tsx) — starting on the first.
  const projectScope = useProjectScope();
  useEffect(() => {
    if (!projectScope.projects) return;
    setProjects(projectScope.projects);
    if (projectScope.projects.length && !projectScope.projects.some((p) => p._id === projectId)) {
      setProjectId(projectScope.projects[0]._id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectScope.projects]);

  const loadVersions = useCallback(() => {
    if (!projectId) return;
    api
      .get<{ versions: NetworkVersion[] }>(`/api/network/versions?projectId=${projectId}`)
      .then((r) => {
        setVersions(r.versions);
        setVersionId((current) => {
          if (current && r.versions.some((v) => v._id === current)) return current;
          return (r.versions.find((v) => v.status === 'active') || r.versions[0])?._id || '';
        });
      })
      .catch((e) => setError(e.message));
  }, [projectId]);

  useEffect(loadVersions, [loadVersions]);

  const primaryVersion = versions.find((v) => v._id === versionId) || null;

  /**
   * The deliveries the project works from, grouped by region. An older re-delivery of the same
   * ground is not live, and offering it would show a copy with nothing on it. (`live` absent means
   * an older API: take everything, as before.)
   */
  const liveVersions = useMemo(() => versions.filter((v) => v.live !== false), [versions]);
  const regions = useMemo(() => {
    const map = new Map<string, NetworkVersion[]>();
    for (const v of liveVersions) map.set(regionOf(v), [...(map.get(regionOf(v)) || []), v]);
    return [...map.entries()]
      .map(([name, list]) => ({ name, versions: list }))
      .sort((a, b) => Number(a.name === UNPLACED) - Number(b.name === UNPLACED) || a.name.localeCompare(b.name));
  }, [liveVersions]);
  const nameOf = useMemo(() => deliveryNamer(liveVersions), [liveVersions]);

  // A remembered filter that no longer fits (renamed region, delivery retired) quietly means "all".
  const region = regions.find((r) => r.name === filter.region) || null;
  const delivery = region?.versions.find((v) => v._id === filter.delivery) || null;
  const inScope = delivery ? [delivery] : region ? region.versions : null;

  /**
   * What every read on the page is scoped to. The whole project; one delivery's id; or several
   * deliveries' ids joined with '~', which the API reads as exactly those deliveries — so the map,
   * the numbers and the tables all narrow together without each needing to know about regions.
   */
  const scopeId = !inScope
    ? projectId
    : inScope.length === 1
      ? inScope[0]._id
      : inScope.map((v) => v._id).sort().join('~');
  const scopeLabel = delivery ? `${region!.name} · ${nameOf(delivery)}` : region ? region.name : null;
  const version = inScope ? inScope.find((v) => v.status === 'active') || inScope[0] : primaryVersion;

  // Region filter: the project's deliveries grouped by where they are. Only worth showing when
  // there is something to choose between. Drawn by ProgressTab, beside the stats.
  const filterBar =
    liveVersions.length > 1 ? (
      <div className="cov-filter">
        <div className="cov-chips" role="radiogroup" aria-label="Region">
          <button
            type="button"
            role="radio"
            aria-checked={!region}
            className={!region ? 'on' : ''}
            onClick={() => pickFilter('')}
          >
            All regions
          </button>
          {regions.map((r) => (
            <button
              key={r.name}
              type="button"
              role="radio"
              aria-checked={region?.name === r.name}
              className={region?.name === r.name ? 'on' : ''}
              onClick={() => pickFilter(r.name)}
              title={`${r.versions.length} deliver${r.versions.length === 1 ? 'y' : 'ies'}`}
            >
              {r.name}
              {r.versions.length > 1 && <em>{r.versions.length}</em>}
            </button>
          ))}
        </div>
        {region && region.versions.length > 1 && (
          <select
            className="input cov-filter-select"
            aria-label="Delivery"
            value={delivery?._id || ''}
            onChange={(e) => pickFilter(region.name, e.target.value)}
          >
            <option value="">All {region.versions.length} deliveries in {region.name}</option>
            {region.versions.map((v) => (
              <option key={v._id} value={v._id}>{nameOf(v)}</option>
            ))}
          </select>
        )}
        {canEdit && (
          <button type="button" className="cov-link cov-filter-edit" onClick={() => setNaming(true)}>
            Name deliveries…
          </button>
        )}
      </div>
    ) : null;

  return (
    <div>
      {/* One slim row: what the page is, its two tabs, and which project. The map below is the
          point of the page, so the chrome above it is kept to two short rows. */}
      <div className="cov-topbar">
        <h1 className="cov-topbar-title" title="Progress against the road network the customer requires driven">
          <PageIcon name="coverage" />Coverage
        </h1>
        <div className="cov-tabs cov-topbar-tabs">
          <button className={tab === 'progress' ? 'active' : ''} onClick={() => setTab('progress')}>Work areas</button>
          <button className={tab === 'imports' ? 'active' : ''} onClick={() => setTab('imports')}>
            Network imports
          </button>
        </div>
        <select
          className="input cov-topbar-project"
          aria-label="Project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p._id} value={p._id}>{p.name}</option>
          ))}
        </select>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)', marginBottom: 12 }}>{error}</div>}

      {naming && (
        <NameDeliveriesModal
          deliveries={liveVersions}
          onClose={() => setNaming(false)}
          onSaved={() => {
            setNaming(false);
            loadVersions();
          }}
        />
      )}

      {tab === 'progress' &&
        (version ? (
          <ProgressTab
            version={version}
            scopeId={scopeId}
            scopeLabel={scopeLabel}
            onChanged={loadVersions}
            canEdit={canEdit}
            deliveries={liveVersions}
            nameOf={nameOf}
            filterRegion={region?.name || ''}
            onPickFilter={pickFilter}
            filterBar={filterBar}
          />
        ) : (
          <div className="card empty-state">
            <h3 style={{ margin: '0 0 6px' }}>No target network yet</h3>
            <p style={{ margin: '0 0 14px', color: 'var(--muted)', fontSize: 14 }}>
              Import the customer&apos;s work-area polygons and road-network shapefiles to give this
              project a denominator — without one, distance driven has nothing to be measured against.
            </p>
            {canEdit && <button className="btn" onClick={() => setTab('imports')}>Import a network</button>}
          </div>
        ))}

      {tab === 'imports' && (
        <ImportsTab projectId={projectId} canEdit={canEdit} onCommitted={loadVersions} />
      )}
    </div>
  );
}

/* ================================================================= progress */

function ProgressTab({
  version,
  scopeId,
  scopeLabel,
  onChanged,
  canEdit,
  deliveries,
  nameOf,
  filterRegion,
  onPickFilter,
  filterBar,
}: {
  /** The newest delivery — used only for actions that target one, like Make active. */
  version: NetworkVersion;
  /**
   * What every READ is scoped to: the project, not a delivery. The API accepts either id in the
   * same position, and a project means "everything this project has" — which is the only way a
   * project holding two states shows both at once.
   */
  scopeId: string;
  /** "New Zealand", "Australia · Victoria" — null when the whole project is in view. */
  scopeLabel: string | null;
  onChanged: () => void;
  canEdit: boolean;
  /** The project's live deliveries, for naming the rows of the By-region table. */
  deliveries: NetworkVersion[];
  nameOf: (v: NetworkVersion) => string;
  filterRegion: string;
  onPickFilter: (region: string, delivery?: string) => void;
  /** The region chips, drawn on the same row as the stats. Null when there is one region. */
  filterBar: ReactNode;
}) {
  const [summary, setSummary] = useState<CoverageSummary | null>(null);
  const [areas, setAreas] = useState<CoverageArea[]>([]);
  const [priority, setPriority] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [assignments, setAssignments] = useState<AreaAssignment[]>([]);
  const [assigning, setAssigning] = useState<CoverageArea[] | null>(null);
  // Two views, not three: who holds an area and how much of it is done are read together, so they
  // share one picture (outline / fill). The customer's priority band is a label rather than a
  // quantity and cannot share that encoding, so it keeps its own view.
  const [mapMode, setMapMode] = useState<'assignment' | 'priority'>('assignment');
  // Areas picked on the map, waiting to be handed to a driver. Territory is carved
  // geographically, so the selection lives on the map rather than in the table.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Which area the map is framing. The areas are six clusters spread across 295 x 263 km, so the
  // all-areas view is mostly empty space — picking a row has to take the camera there.
  const [focusAreaId, setFocusAreaId] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  // Layer switches. Verifying an area is a different job from browsing the programme: the
  // polygons that make the overview readable are exactly what hides the streets underneath.
  const [showAreasLayer, setShowAreasLayer] = useState(true);
  // Roads means ALL roads in view, across every polygon — not just the one that happens to be
  // selected. Picking an area additionally loads that area's roads in full, at any zoom.
  /**
   * Which roads are drawn. One setting, because "show me the roads" is one question asked at three
   * scales: the territory out with crews, everything ever driven, or everything inside every
   * polygon in view. The last exists because the first two are complete but narrow, and a
   * dispatcher looking at a region wants the outstanding red in areas nobody holds yet.
   */
  // Every road, at full detail, by default: the whole network loads once (and is kept by the
  // browser), so there is nothing to be gained by showing less until someone zooms in.
  const [roadScope, setRoadScope] = useState<'off' | 'assigned' | 'covered' | 'all'>('all');
  // Off by default: red/blue is the contract the phone uses, and per-driver hues override it.
  const [colorRoadsByDriver, setColorRoadsByDriver] = useState(false);
  /** Everyone with driven road on this network — NOT the same set as "everyone holding a polygon". */
  const [coverageDrivers, setCoverageDrivers] = useState<
    { driverId: string | null; name: string; links: number; meters: number }[]
  >([]);
  /**
   * Where each driver left off: the last fix of their last drive on this project, refreshed every
   * minute. On by default — "where is the crew up to" is the question the map gets opened with.
   */
  const [showPositions, setShowPositions] = useState(true);
  const [positions, setPositions] = useState<DriverPosition[]>([]);
  /** When the positions were last read. Every "3 h ago" on the page is measured from it. */
  const [clock, setClock] = useState(() => Date.now());
  /** The driver whose pin is picked. Their card takes the place of the area card while it is. */
  const [pinDriverId, setPinDriverId] = useState<string | null>(null);
  const pinDriverRef = useRef(pinDriverId);
  pinDriverRef.current = pinDriverId;
  const [pinFocus, setPinFocus] = useState<{ lon: number; lat: number; nonce: number } | null>(null);
  /** The picked driver's last drive, once fetched. Null while it loads. */
  const [trail, setTrail] = useState<{ pending: boolean; paths: [number, number][][] } | null>(null);
  // Driven tracks are off by default: they are the heaviest layer on the map and the one a
  // manager turns ON to answer a specific question, rather than the backdrop they browse in.
  const [showTracks, setShowTracks] = useState(false);
  const [tracksFrom, setTracksFrom] = useState(() => isoDay(-14));
  const [tracksTo, setTracksTo] = useState(() => isoDay(0));
  const [tracksMeta, setTracksMeta] = useState<{
    count: number;
    pendingSnap: number;
    truncated: boolean;
  } | null>(null);
  // Stable identity: the map re-fetches whenever this changes, so an inline arrow would loop.
  const onTracksMeta = useCallback(
    (m: { count: number; pendingSnap: number; truncated: boolean }) => setTracksMeta(m),
    []
  );
  // The click-a-polygon panel: the numbers a manager cross-verifies before signing an area off.
  const [detail, setDetail] = useState<AreaCoverageDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Exactly one area picked is the "inspect this" gesture; a multi-selection is the "assign these"
  // gesture and keeps the old bar.
  const singleAreaId = selectedIds.length === 1 ? selectedIds[0] : null;

  // Bumped on every request to frame an area, so asking for the same area twice still moves the
  // camera — after panning away, "take me back to Gachibowli" must work the second time too.
  const [focusNonce, setFocusNonce] = useState(0);

  const showAreaOnMap = useCallback((areaId: string) => {
    setFocusAreaId(areaId);
    setFocusNonce((n) => n + 1);
    mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  /**
   * A search hit: fly there AND select it. Selecting is the point — one selected area opens the
   * panel with Assign in it, so finding a suburb by name and handing it to a driver is two
   * actions, not a hunt across the map for a polygon you can only identify by hovering.
   */
  // The row the search handed back, kept so "Assign driver…" works for it even when the areas
  // table below is filtered to something else and does not contain it.
  const searchPickRef = useRef<CoverageArea | null>(null);
  const pickAreaFromSearch = useCallback((area: CoverageArea) => {
    searchPickRef.current = area;
    setPinDriverId(null);
    setSelectedIds([area._id]);
    setFocusAreaId(area._id);
    setFocusNonce((n) => n + 1);
  }, []);

  /** Plain click replaces the selection; shift/ctrl-click builds a cluster up one area at a time. */
  const toggleSelect = useCallback((areaId: string, additive: boolean) => {
    // Clicking a polygon asks about the area, so a picked driver's card gives way to it. If that
    // area was already the one selected, the click only brings its card back — it must not also
    // deselect it.
    const hadPin = pinDriverRef.current != null;
    setPinDriverId(null);
    setSelectedIds((prev) => {
      if (!additive) {
        if (prev.length === 1 && prev[0] === areaId) return hadPin ? prev : [];
        return [areaId];
      }
      return prev.includes(areaId) ? prev.filter((id) => id !== areaId) : [...prev, areaId];
    });
  }, []);

  /** The panel's numbers, reloaded whenever the picked area changes or an action lands. */
  const loadDetail = useCallback(
    (areaId: string | null) => {
      if (!areaId) {
        setDetail(null);
        setDetailError(null);
        return;
      }
      setDetailBusy(true);
      api
        .get<AreaCoverageDetail>(`/api/network/versions/${scopeId}/areas/${areaId}/coverage`)
        .then((r) => {
          setDetail(r);
          setDetailError(null);
        })
        .catch((e) => {
          setDetail(null);
          setDetailError(e instanceof Error ? e.message : 'Could not load this area');
        })
        .finally(() => setDetailBusy(false));
    },
    [scopeId]
  );

  useEffect(() => loadDetail(singleAreaId), [singleAreaId, loadDetail]);

  // Bumped after a sign-off so the table, the stat strip and the choropleth all catch up.
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * Sign the area off, or put it back in play.
   *
   * Completing also releases whoever holds it (server side), which is what makes the verdict mean
   * something on the ground: the roads stop appearing as work on the driver's phone.
   */
  const setCompletion = async (complete: boolean) => {
    if (!detail) return;
    const areaId = detail.area._id;
    setDetailBusy(true);
    setDetailError(null);
    try {
      await api.post(
        `/api/network/versions/${scopeId}/areas/${areaId}/${complete ? 'complete' : 'reopen'}`,
        {}
      );
      loadDetail(areaId);
      loadAssignments();
      setReloadKey((n) => n + 1);
      onChanged();
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : 'That did not save');
    } finally {
      setDetailBusy(false);
    }
  };

  /** The area being split into zones, while its dialog is open. */
  const [splitting, setSplitting] = useState<AreaCoverageDetail['area'] | null>(null);
  /** The area whose driven data is about to be cleared, while its "are you sure?" is open. */
  const [clearing, setClearing] = useState<AreaCoverageDetail | null>(null);

  /**
   * Put a split area back together — from the card of any one of its zones.
   *
   * The way to change the zone size: join, then split again. The server refuses while a zone is
   * in a driver's hands or signed off, and says which.
   */
  const joinZones = async () => {
    if (!detail?.area.splitFrom) return;
    const { name, zones } = detail.area.splitFrom;
    const ok = window.confirm(
      `Join ${zones ? `all ${zones} zones` : 'the zones'} of ${name} back into one area?\n\n` +
      'The zones are removed and the area returns as it was. Roads already driven stay driven. ' +
      'You can then split it again at a different size.'
    );
    if (!ok) return;
    setDetailBusy(true);
    setDetailError(null);
    try {
      const r = await api.post<{ area: { _id: string } }>(
        `/api/network/versions/${scopeId}/areas/${detail.area._id}/join`,
        {}
      );
      setSelectedIds(r.area?._id ? [r.area._id] : []);
      loadAssignments();
      setReloadKey((n) => n + 1);
      onChanged();
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : 'The zones could not be joined');
    } finally {
      setDetailBusy(false);
    }
  };

  const loadAssignments = useCallback(() => {
    api
      .get<{ assignments: AreaAssignment[] }>(`/api/network/versions/${scopeId}/assignments`)
      .then((r) => setAssignments(r.assignments))
      .catch(() => setAssignments([]));
  }, [scopeId]);

  useEffect(loadAssignments, [loadAssignments]);

  useEffect(() => {
    api
      .get<{ drivers: typeof coverageDrivers }>(`/api/network/versions/${scopeId}/coverage-drivers`)
      .then((r) => setCoverageDrivers(r.drivers || []))
      .catch(() => setCoverageDrivers([]));
  }, [scopeId, reloadKey]);

  // A different project — or region — is a different crew and different areas: nothing picked in
  // the last one may linger on the map.
  useEffect(() => {
    setPositions([]);
    setPinDriverId(null);
    setSelectedIds([]);
    setFocusAreaId(null);
  }, [scopeId]);

  useEffect(() => {
    if (!showPositions) {
      setPositions([]);
      setPinDriverId(null);
      return undefined;
    }
    let alive = true;
    const load = () => {
      // A hidden tab asks for nothing; it catches up the moment it is looked at again.
      if (document.hidden) return;
      api
        .get<{ positions: DriverPosition[] }>(`/api/network/versions/${scopeId}/driver-positions`)
        .then((r) => {
          if (!alive) return;
          setPositions(r.positions || []);
          setClock(Date.now());
        })
        // A refresh that fails keeps the last picture rather than blanking the map.
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 60_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [scopeId, showPositions, reloadKey]);

  // Who has a position, as a string that changes only when the SET of drivers does. The pins
  // refresh every minute, and the palette below must not be rebuilt — and every road on the map
  // recoloured — along with them.
  const positionDriversKey = useMemo(
    () => positions.map((p) => `${p.driverId}\t${p.name}`).sort().join('\n'),
    [positions]
  );

  // areaId -> the drivers currently responsible for it. Built once per load rather than filtered
  // per row, so a 402-row table is not 402 passes over the assignment list.
  const driversByArea = useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const a of assignments) {
      const driver =
        typeof a.driverId === 'object' && a.driverId
          ? { id: a.driverId._id, name: a.driverId.name }
          : { id: String(a.driverId), name: a.driverName || 'Unknown' };
      const list = map.get(String(a.areaId)) || [];
      list.push(driver);
      map.set(String(a.areaId), list);
    }
    return map;
  }, [assignments]);

  useEffect(() => {
    api
      .get<{ coverage: CoverageSummary }>(`/api/network/versions/${scopeId}`)
      .then((r) => setSummary(r.coverage))
      .catch(() => setSummary(null));
  }, [scopeId, reloadKey]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (priority !== '') params.set('priority', priority);
    if (query.trim()) params.set('q', query.trim());
    const t = setTimeout(() => {
      api
        .get<{ areas: CoverageArea[] }>(`/api/network/versions/${scopeId}/areas?${params}`)
        .then((r) => setAreas(r.areas))
        .catch(() => setAreas([]));
    }, 250);
    return () => clearTimeout(t);
  }, [scopeId, priority, query, reloadKey]);

  const activate = async () => {
    setBusy(true);
    try {
      await api.post(`/api/network/versions/${version._id}/activate`, {});
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to activate');
    } finally {
      setBusy(false);
    }
  };

  /**
   * A stable colour per driver, so the territory carve-up is readable at a glance and does not
   * reshuffle every time the assignment list reloads. Keyed off the sorted driver id list rather
   * than array order, which is why re-fetching does not repaint everyone a different colour.
   */
  const driverViz = useMemo(() => {
    /**
     * No red in here, deliberately. Red is "still to drive" everywhere else on this map and on
     * the driver's phone, so handing it to a person made their finished roads indistinguishable
     * from outstanding ones — which is exactly what happened before it was removed.
     */
    const PALETTE: [number, number, number][] = [
      [0, 80, 169], [37, 99, 235], [5, 150, 105], [217, 119, 6],
      [219, 39, 119], [8, 145, 178], [132, 204, 22], [120, 53, 15],
      [99, 102, 241], [20, 184, 166], [234, 88, 12], [168, 85, 247],
    ];
    /**
     * Everyone the map might need a colour for: whoever holds a polygon AND whoever has driven
     * road on this network. Those two sets diverge the moment an area is released or a history
     * import lands, and colouring only the holders left thousands of kilometres of real work
     * drawn in a default blue with nobody's name against it.
     */
    // …and whoever has a position here: a driver's first day shows up as a pin before it shows
    // up as coverage.
    const positionDrivers = positionDriversKey
      ? positionDriversKey.split('\n').map((row) => row.split('\t') as [string, string])
      : [];
    const ids = [...new Set([
      ...assignments.map((a) =>
        typeof a.driverId === 'object' && a.driverId ? a.driverId._id : String(a.driverId)
      ),
      ...coverageDrivers.map((d) => d.driverId).filter((id): id is string => Boolean(id)),
      ...positionDrivers.map(([id]) => id),
    ])].sort();
    const nameFromPosition = new Map(positionDrivers);
    const colorFor = new Map(ids.map((id, i) => [id, PALETTE[i % PALETTE.length]]));
    const metersById = new Map(coverageDrivers.map((d) => [String(d.driverId), d.meters]));
    const nameFromCoverage = new Map(coverageDrivers.map((d) => [String(d.driverId), d.name]));

    const byArea: Record<string, [number, number, number]> = {};
    const namesByArea: Record<string, string[]> = {};
    const nameFor = new Map<string, string>();

    for (const a of assignments) {
      const id = typeof a.driverId === 'object' && a.driverId ? a.driverId._id : String(a.driverId);
      const name =
        (typeof a.driverId === 'object' && a.driverId ? a.driverId.name : null) ||
        a.driverName ||
        'Unknown';
      nameFor.set(id, name);

      const areaKey = String(a.areaId);
      // First holder wins the FILL — a polygon has one colour. Every holder is listed in
      // `namesByArea`, which is what the tooltip shows, so a shared area is still legible.
      if (!byArea[areaKey]) byArea[areaKey] = colorFor.get(id)!;
      (namesByArea[areaKey] ||= []).push(name);
    }

    // Most road driven first. Alphabetical would bury the person who did 3,701 km under a test
    // account that holds an empty area.
    const legend = ids
      .map((id) => ({
        id,
        name: nameFor.get(id) || nameFromCoverage.get(id) || nameFromPosition.get(id) || 'Unknown',
        color: colorFor.get(id)!,
        meters: metersById.get(id) || 0,
      }))
      .sort((a, b) => b.meters - a.meters || a.name.localeCompare(b.name));

    // Same palette keyed by driver, so a driven track and the polygons that driver holds are
    // visibly the same person.
    const byDriver: Record<string, [number, number, number]> = {};
    for (const [id, color] of colorFor) byDriver[id] = color;

    return { byArea, namesByArea, legend, byDriver };
  }, [assignments, coverageDrivers, positionDriversKey]);

  const selectedAreas = useMemo(
    () => areas.filter((a) => selectedIds.includes(a._id)),
    [areas, selectedIds]
  );

  /**
   * Drivers focused from the crew panel. Empty means everyone — focusing narrows the picture to
   * "what is Morgan's": their tracks, their driven roads, their polygons, with the rest faded
   * rather than hidden so the territory keeps its context.
   */
  const [driverFilter, setDriverFilter] = useState<string[]>([]);
  const toggleDriver = (id: string) =>
    setDriverFilter((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));

  /** Areas held by a focused driver, or null when nobody is focused (nothing is faded). */
  const highlightAreaIds = useMemo(() => {
    if (!driverFilter.length) return null;
    const wanted = new Set(driverFilter);
    const ids = new Set<string>();
    for (const a of assignments) {
      const id = typeof a.driverId === 'object' && a.driverId ? a.driverId._id : String(a.driverId);
      if (wanted.has(id)) ids.add(String(a.areaId));
    }
    return ids;
  }, [driverFilter, assignments]);

  const positionById = useMemo(() => new Map(positions.map((p) => [p.driverId, p])), [positions]);
  const pinned = pinDriverId ? positionById.get(pinDriverId) ?? null : null;
  const pinnedColor = pinned ? driverViz.byDriver[pinned.driverId] || PIN_FALLBACK : null;

  // The picked driver is no longer among the positions (moved off the project): drop the pick.
  useEffect(() => {
    if (pinDriverId && positions.length && !positionById.has(pinDriverId)) setPinDriverId(null);
  }, [pinDriverId, positions, positionById]);

  /** The pins as the map draws them. A focused crew narrows them, like everything else. */
  const driverPins = useMemo<DriverPin[]>(() => {
    const wanted = driverFilter.length ? new Set(driverFilter) : null;
    return positions
      .filter((p) => !wanted || wanted.has(p.driverId) || p.driverId === pinDriverId)
      .map((p) => ({
        kind: 'pin' as const,
        driverId: p.driverId,
        name: p.name,
        lon: p.lon,
        lat: p.lat,
        state: p.state,
        color: driverViz.byDriver[p.driverId] || PIN_FALLBACK,
        alpha: pinAlpha(p, clock),
        status: statusText(p, clock),
        where: whereText(p),
      }))
      // Later is drawn on top: finished drives underneath, whoever is out now above them, and the
      // picked pin over everything.
      .sort(
        (a, b) =>
          Number(a.driverId === pinDriverId) - Number(b.driverId === pinDriverId) ||
          PIN_RANK[a.state] - PIN_RANK[b.state]
      );
  }, [positions, driverFilter, pinDriverId, driverViz.byDriver, clock]);

  // The route of the picked driver's last drive. Keyed on the trip, not on the position, so the
  // minute-by-minute refresh does not refetch it — only a new drive does, or the matcher finishing.
  const pinnedTripId = pinned?.trip.id ?? null;
  const pinnedSnapped = pinned?.trip.snapped ?? false;
  useEffect(() => {
    setTrail(null);
    if (!pinnedTripId) return undefined;
    let alive = true;
    api
      .get<{ pending: boolean; shapes: string[] }>(
        `/api/network/versions/${scopeId}/driver-positions/route?tripId=${pinnedTripId}`
      )
      .then((r) => {
        if (!alive) return;
        setTrail({
          pending: r.pending,
          // A one-point chunk is not a line; deck.gl would draw nothing and warn.
          paths: r.shapes.map(decodePolyline6).filter((path) => path.length > 1),
        });
      })
      .catch(() => {
        if (alive) setTrail({ pending: false, paths: [] });
      });
    return () => {
      alive = false;
    };
  }, [scopeId, pinnedTripId, pinnedSnapped]);

  const pinTrail = useMemo(
    () => (trail && trail.paths.length && pinnedColor ? { color: pinnedColor, paths: trail.paths } : null),
    [trail, pinnedColor]
  );

  const onPickPin = useCallback((driverId: string | null) => setPinDriverId(driverId), []);
  /** From the crew list: go to where this driver is, and open their card. */
  const locateDriver = (p: DriverPosition) => {
    setPinDriverId(p.driverId);
    setPinFocus((prev) => ({ lon: p.lon, lat: p.lat, nonce: (prev?.nonce ?? 0) + 1 }));
  };
  /** From a driver's card: the area they stopped in, selected and framed like a search hit. */
  const openAreaOf = (p: DriverPosition) => {
    if (!p.area) return;
    setPinDriverId(null);
    setSelectedIds([p.area._id]);
    setFocusAreaId(p.area._id);
    setFocusNonce((n) => n + 1);
  };

  /**
   * The map fills whatever the screen has left below the header rows, so it is seen whole without
   * scrolling — on a laptop and on a big monitor alike. Measured against the page's scroll box
   * (.content), and again whenever that box or the rows above the map change size.
   */
  const headRef = useRef<HTMLDivElement>(null);
  const [mapHeight, setMapHeight] = useState(620);
  useLayoutEffect(() => {
    const card = mapRef.current;
    const box = card?.closest('.content') as HTMLElement | null;
    if (!card || !box) return undefined;
    const measure = () => {
      const top = card.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      const fit = Math.max(440, Math.round(box.clientHeight - top - 20));
      setMapHeight((prev) => (Math.abs(prev - fit) < 3 ? prev : fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    if (headRef.current) ro.observe(headRef.current);
    return () => ro.disconnect();
  }, []);

  // Every control lives ON the map, so fullscreen loses nothing — it takes the whole card along.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === mapRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else mapRef.current?.requestFullscreen?.().catch(() => {});
  };

  const [layersOpen, setLayersOpen] = useState(false);
  const layersRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!layersOpen) return undefined;
    const onDown = (e: MouseEvent) => {
      if (layersRef.current && !layersRef.current.contains(e.target as Node)) setLayersOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLayersOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [layersOpen]);
  const [crewOpen, setCrewOpen] = useState(true);

  /** A tracks window ending today, N days long — the three windows people actually ask about. */
  const tracksPreset = (days: number) => {
    setTracksFrom(isoDay(-days));
    setTracksTo(isoDay(0));
    setShowTracks(true);
  };
  const activePreset = tracksTo === isoDay(0)
    ? [7, 14, 30].find((d) => tracksFrom === isoDay(-d)) ?? null
    : null;

  /** Drawn layers, counted for the badge on the Layers button so a closed panel still says so. */
  const layersOn =
    Number(showAreasLayer) + Number(roadScope !== 'off') + Number(showTracks) + Number(showPositions);

  /**
   * Denominators come from the SUMMARY, which is project-wide. `version` is only the newest
   * delivery, and mixing the two printed "335 assigned" beside "134 work areas".
   */
  const covered = summary?.coveredMeters || 0;
  const target = summary?.targetMeters || version.targetMeters;
  const remaining = Math.max(0, target - covered);
  const totalAreas = summary?.totalAreas ?? version.counts.areas;
  const totalLinks = summary?.targetLinks ?? version.counts.links;
  const completedCount = summary?.completedAreas ?? 0;
  const assignedCount = summary?.assignedAreas ?? 0;
  // Completing an area releases its holder, so the two counts do not overlap.
  const openCount = Math.max(0, totalAreas - completedCount - assignedCount);
  const donePct = pct(covered, target);

  /**
   * The figures split by where they are. Everything in view and more than one region: a row per
   * region, which picks it. One region (or a project in one place) holding several deliveries: a
   * row per delivery, which picks that. A single delivery in view: no table — the page is it.
   */
  const breakdown = useMemo(() => {
    const rows = summary?.byDelivery || [];
    if (rows.length < 2) return null;
    const byId = new Map(deliveries.map((v) => [v._id, v]));
    const regionFor = (d: DeliveryBreakdown) => regionOf(byId.get(d.versionId) || d);
    type Row = Omit<DeliveryBreakdown, 'versionId' | 'label' | 'region' | 'status' | 'createdAt'> & {
      key: string;
      name: string;
      sub: string;
      pick: () => void;
    };
    const blank = { areas: 0, links: 0, targetMeters: 0, coveredMeters: 0, coveredLinks: 0, completedAreas: 0, assignedAreas: 0 };
    const add = (acc: Row, d: DeliveryBreakdown) => {
      for (const k of Object.keys(blank) as (keyof typeof blank)[]) acc[k] += d[k];
    };

    const regionNames = new Set(rows.map(regionFor));
    if (!filterRegion && regionNames.size > 1) {
      const groups = new Map<string, Row>();
      const deliveriesIn = new Map<string, number>();
      for (const d of rows) {
        const name = regionFor(d);
        const acc = groups.get(name) || { ...blank, key: name, name, sub: '', pick: () => onPickFilter(name) };
        add(acc, d);
        groups.set(name, acc);
        deliveriesIn.set(name, (deliveriesIn.get(name) || 0) + 1);
      }
      return {
        title: 'By region',
        hint: 'Where the work is. Pick a region to see only its areas, drivers and figures.',
        rows: [...groups.values()]
          .map((r) => {
            const n = deliveriesIn.get(r.name) || 0;
            return { ...r, sub: `${n} deliver${n === 1 ? 'y' : 'ies'}` };
          })
          .sort((a, b) => b.targetMeters - a.targetMeters),
      };
    }
    return {
      title: 'By delivery',
      hint: 'Each import the customer sent. Pick one to see only its areas.',
      rows: rows
        .map((d) => {
          const v = byId.get(d.versionId);
          const row: Row = {
            ...blank,
            key: d.versionId,
            name: v ? nameOf(v) : d.label,
            sub: `${regionFor(d)} · imported ${new Date(d.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
            pick: () => onPickFilter(regionFor(d), d.versionId),
          };
          add(row, d);
          return row;
        })
        .sort((a, b) => b.targetMeters - a.targetMeters),
    };
  }, [summary, deliveries, nameOf, filterRegion, onPickFilter]);
  const maxCrewMeters = Math.max(1, ...driverViz.legend.map((d) => d.meters));

  /**
   * One polygon picked = inspect it. This is the card a manager cross-verifies in before signing
   * the area off: the total, the split by who actually drove it first, and who is holding it now.
   * It is pinned beside the polygon on the map (see CoverageMap's areaPopup).
   */
  // Only the picked area's numbers — never the previous area's for the moment the new one loads.
  const shownDetail = detail && detail.area._id === singleAreaId ? detail : null;
  const shownDone = shownDetail?.completion?.status === 'completed';
  const areaCard = singleAreaId ? (
    <div className="cov-pop-card">
      {!shownDetail && !detailError && (
        <div className="cov-pop-loading"><span className="cov-spinner" /> Loading area…</div>
      )}
      {detailError && (
        <div className="cov-pop-head">
          <div className="error-text" style={{ flex: 1 }}>{detailError}</div>
          <button type="button" className="cov-pop-x" aria-label="Close" onClick={() => setSelectedIds([])}>✕</button>
        </div>
      )}
      {shownDetail && (
        <>
          <div className="cov-pop-head">
            <div className="cov-pop-title">
              <strong>{shownDetail.area.name}</strong>
              <span>
                {shownDetail.area.parentName ? `${shownDetail.area.parentName} · ` : ''}
                P{shownDetail.area.priority} · {shownDetail.area.areaCode}
              </span>
            </div>
            <button type="button" className="cov-pop-x" aria-label="Close" onClick={() => setSelectedIds([])}>✕</button>
          </div>

          <div className="cov-pop-status">
            {shownDone ? (
              <span className="cov-pill green">✓ Completed</span>
            ) : shownDetail.assignments.length ? (
              <span className="cov-pill blue">Assigned</span>
            ) : (
              <span className="cov-pill gray">Unassigned</span>
            )}
            {shownDetail.assignments.length > 0 && (
              <span className="cov-pop-holder">
                {shownDetail.assignments.map((a) => a.driverName || 'Unknown').join(', ')}
              </span>
            )}
          </div>

          <div className="cov-pop-progress">
            <div className="cov-pop-progress-row">
              <span>Roads driven</span>
              <b>{shownDetail.pct.toFixed(1)}%</b>
            </div>
            <div className="cov-bar">
              <div className="cov-bar-fill green" style={{ width: `${Math.min(100, shownDetail.pct)}%` }} />
            </div>
            <div className="cov-pop-muted">
              {km(shownDetail.coveredMeters)} of {km(shownDetail.area.targetMeters)} km
              {shownDetail.assignments.length > 0 &&
                ` · ${shownDetail.assignedPct.toFixed(1)}% by the current holder`}
            </div>
          </div>

          {/* Who got there first, because first-cover-wins is fleet-wide: an area can go green
              because another crew drove it, and a sign-off must not silently imply the assigned
              driver did the work. */}
          {shownDetail.byDriver.length > 0 && (
            <div className="cov-pop-drivers">
              {shownDetail.byDriver.slice(0, 4).map((d) => (
                <div key={d.driverId || 'none'}>
                  <span
                    className="cov-crew-dot"
                    style={{ background: `rgb(${(d.driverId && driverViz.byDriver[d.driverId] || [148, 163, 184]).join(',')})` }}
                  />
                  <span className="name">{d.name}</span>
                  <span className="cov-pop-muted">{km(d.meters)} km · {d.links.toLocaleString()} roads</span>
                </div>
              ))}
            </div>
          )}

          {shownDone && shownDetail.completion && (
            <div className="cov-pop-done">
              Signed off
              {shownDetail.completion.completedByName ? ` by ${shownDetail.completion.completedByName}` : ''}
              {shownDetail.completion.completedAt
                ? ` · ${new Date(shownDetail.completion.completedAt).toLocaleDateString()}`
                : ''}
              {typeof shownDetail.completion.pctAtCompletion === 'number'
                ? ` · at ${shownDetail.completion.pctAtCompletion.toFixed(1)}%`
                : ''}
            </div>
          )}

          <div className="cov-pop-actions">
            {canEdit && !shownDone && (
              <button className="btn" disabled={detailBusy} onClick={() => setCompletion(true)}>
                ✓ Mark completed
              </button>
            )}
            {canEdit && shownDone && (
              <button className="btn-ghost" disabled={detailBusy} onClick={() => setCompletion(false)}>
                Reopen
              </button>
            )}
            {canEdit && !shownDone && (
              <button
                className="btn-ghost"
                onClick={() => {
                  const row = areas.find((a) => a._id === shownDetail.area._id)
                    ?? (searchPickRef.current?._id === shownDetail.area._id ? searchPickRef.current : null);
                  if (row) setAssigning([row]);
                }}
              >
                Assign driver…
              </button>
            )}
            {/* Too much road for one driver? Cut it into zones of a chosen size. Only while nobody
                holds it: an assignment is keyed by the area's code, which is about to change. */}
            {canEdit && !shownDone && !shownDetail.area.splitFrom && shownDetail.assignments.length === 0 && (
              <button className="btn-ghost" disabled={detailBusy} onClick={() => setSplitting(shownDetail.area)}>
                Split into zones…
              </button>
            )}
            {canEdit && shownDetail.area.splitFrom && (
              <button className="btn-ghost" disabled={detailBusy} onClick={joinZones}>
                Join zones back…
              </button>
            )}
            {/* Hand the area over afresh: the ledger is fleet-wide, so a second driver would open
                it already blue. Asks first — this wipes recorded progress. */}
            {canEdit && !shownDone && shownDetail.coveredLinks > 0 && (
              <button className="btn-danger" disabled={detailBusy} onClick={() => setClearing(shownDetail)}>
                Clear driven data…
              </button>
            )}
            {shownDetail.area.bbox && shownDetail.area.bbox.length === 4 && (
              <a
                className="cov-pop-link"
                href={`https://www.google.com/maps?q=${(
                  (shownDetail.area.bbox[1] + shownDetail.area.bbox[3]) / 2
                ).toFixed(5)},${((shownDetail.area.bbox[0] + shownDetail.area.bbox[2]) / 2).toFixed(5)}`}
                target="_blank"
                rel="noreferrer"
              >
                Google Maps ↗
              </a>
            )}
          </div>

          <div className="cov-pop-foot">
            {shownDone
              ? 'Completed areas cannot be assigned to another driver without an override.'
              : 'Completing releases the driver, takes these roads off their phone and shows them all as done (blue) here.'}
            {shownDetail.area.splitFrom &&
              ` One of ${shownDetail.area.splitFrom.zones ?? 'the'} zones ${shownDetail.area.splitFrom.name} was split into.`}
            {shownDetail.lastCleared &&
              ` Driven data cleared ${new Date(shownDetail.lastCleared.at).toLocaleDateString()}${shownDetail.lastCleared.byName ? ` by ${shownDetail.lastCleared.byName}` : ''}.`}
          </div>
        </>
      )}
    </div>
  ) : null;

  /**
   * One pin picked = where that driver is up to: when and where the last drive stopped, whether
   * that is their own patch, and the way to the trip itself. The route of that drive is drawn on
   * the map behind it.
   */
  const pinCard = pinned ? (
    <div className="cov-pop-card">
      <div className="cov-pop-head">
        <span
          className="cov-crew-dot"
          style={{ background: `rgb(${(pinnedColor || PIN_FALLBACK).join(',')})`, marginTop: 5, flexShrink: 0 }}
        />
        <div className="cov-pop-title">
          <strong>{pinned.name}</strong>
          <span>{statusText(pinned, clock)}</span>
        </div>
        <button type="button" className="cov-pop-x" aria-label="Close" onClick={() => setPinDriverId(null)}>✕</button>
      </div>

      <div className="cov-pop-status">
        <span className={`cov-pill ${POSITION_PILL[pinned.state].tone}`}>{POSITION_PILL[pinned.state].label}</span>
        {pinned.state === 'moving' && pinned.speedKmh != null && pinned.speedKmh >= 1 && (
          <span className="cov-pop-holder">{Math.round(pinned.speedKmh)} km/h</span>
        )}
      </div>

      <dl className="cov-pop-facts">
        <dt>{pinned.state === 'ended' ? 'Left off' : 'Last seen'}</dt>
        <dd>{sessionDt(pinned.at)}</dd>
        <dt>Where</dt>
        <dd>
          {pinned.area ? (
            <>
              {pinned.area.name}
              <small>{pinned.area.mine ? 'one of their own areas' : 'not an area they hold'}</small>
            </>
          ) : (
            'Outside every work area'
          )}
        </dd>
        <dt>{pinned.trip.endedAt ? 'Last drive' : 'This drive'}</dt>
        <dd>
          {km(pinned.trip.meters)} km
          <small>started {sessionDt(pinned.trip.startedAt)}</small>
        </dd>
      </dl>

      <div className="cov-pop-actions">
        {pinned.area && (
          <button className="btn-ghost" onClick={() => openAreaOf(pinned)}>Open this area</button>
        )}
        <Link className="cov-pop-link" to={`/trips/${pinned.trip.id}`} target="_blank" rel="noreferrer">
          Trip ↗
        </Link>
        <a
          className="cov-pop-link"
          style={{ marginLeft: 4 }}
          href={`https://www.google.com/maps?q=${pinned.lat.toFixed(6)},${pinned.lon.toFixed(6)}`}
          target="_blank"
          rel="noreferrer"
        >
          Google Maps ↗
        </a>
      </div>

      <div className="cov-pop-foot">
        {!trail
          ? 'Loading the route of this drive…'
          : trail.paths.length
            ? 'The band in their colour is the route of this drive, up to where it stopped.'
            : trail.pending
              ? pinned.trip.endedAt
                ? 'The route of this drive is still being snapped to roads — it will appear here shortly.'
                : 'The route is drawn once this drive has ended and been snapped to roads.'
              : 'This drive has no snapped route to draw.'}
      </div>
    </div>
  ) : null;

  return (
    <>
      {version.status !== 'active' && version.live === false && canEdit && (
        <div className="card cov-notice">
          <div>
            <strong>This version is not active.</strong>{' '}
            <span style={{ color: 'var(--muted)' }}>
              Coverage is only recorded against the active version. Activating supersedes the
              current one without deleting it.
            </span>
          </div>
          <button className="btn" disabled={busy} onClick={activate}>Make active</button>
        </div>
      )}

      {/* The headline, in one slim strip beside the region chips: how far along (with the bar), the
          areas by state, and who is on the map. It used to be a tall card that pushed the map half
          off the screen. */}
      <div ref={headRef} className="cov-head-row">
        {filterBar}
        <div className="card cov-strip">
          <div className="cov-strip-main" title={`${km(remaining)} km still to drive · ${totalLinks.toLocaleString()} road links`}>
            <span className="cov-strip-pct">{donePct.toFixed(1)}<small>%</small></span>
            <div className="cov-strip-col">
              <div className="cov-strip-line">
                <b>{km(covered)}</b> of {km(target)} km driven{scopeLabel ? <span className="cov-strip-scope"> · {scopeLabel}</span> : null}
              </div>
              <div className="cov-meter" role="img" aria-label={`${donePct.toFixed(1)}% of the target network driven`}>
                <div className="cov-meter-fill" style={{ width: `${Math.min(100, donePct)}%` }} />
              </div>
              <div className="cov-strip-sub"><b>{km(remaining)} km</b> to drive · {totalLinks.toLocaleString()} links</div>
            </div>
          </div>

          <div className="cov-strip-areas">
            <div className="cov-strip-line"><b>{totalAreas.toLocaleString()}</b> work areas</div>
            <div className="cov-stack" role="img" aria-label="Work areas by state">
              <span className="done" style={{ flexGrow: completedCount }} />
              <span className="held" style={{ flexGrow: assignedCount }} />
              <span className="open" style={{ flexGrow: openCount }} />
            </div>
            <div className="cov-stack-key">
              <span><i className="done" />{completedCount.toLocaleString()} signed off</span>
              <span><i className="held" />{assignedCount.toLocaleString()} with a driver</span>
              <span><i className="open" />{openCount.toLocaleString()} waiting</span>
            </div>
          </div>

          <div className="cov-strip-facts">
            <span><b>{coverageDrivers.length.toLocaleString()}</b> drivers with coverage</span>
            <span>
              {showTracks && tracksMeta ? (
                <>
                  <b>{tracksMeta.count.toLocaleString()}{tracksMeta.truncated ? '+' : ''}</b> trips on the map
                  {tracksMeta.pendingSnap > 0 && ` · ${tracksMeta.pendingSnap} snapping`}
                </>
              ) : (
                'Tracks hidden'
              )}
            </span>
          </div>
        </div>
      </div>

      {/* The map is the view, not a place you navigate to. Every control floats on it, so the
          fullscreen view is the same tool rather than a stripped-down one. */}
      <div
        ref={mapRef}
        className={`card cov-map-card${isFullscreen ? ' is-fullscreen' : ''}`}
        style={{ padding: 0, marginBottom: 16, overflow: 'hidden', position: 'relative' }}
      >
        <div className="cov-map-toolbar">
          <AreaSearch scopeId={scopeId} onPick={pickAreaFromSearch} />

          <div ref={layersRef} style={{ position: 'relative' }}>
            <button
              type="button"
              className={`cov-map-btn${layersOpen ? ' active' : ''}`}
              onClick={() => setLayersOpen((o) => !o)}
              aria-expanded={layersOpen}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M8 1.5 1.5 5 8 8.5 14.5 5 8 1.5Z" />
                <path d="M1.5 8 8 11.5 14.5 8" />
                <path d="M1.5 11 8 14.5 14.5 11" />
              </svg>
              Layers
              <span className="cov-badge">{layersOn}</span>
            </button>

            {layersOpen && (
              <div className="cov-layers-pop">
                <section>
                  <header>
                    <span>Work areas</span>
                    <Switch checked={showAreasLayer} onChange={setShowAreasLayer} title="Draw the work-area polygons">
                      <span className="sr-only">Show work areas</span>
                    </Switch>
                  </header>
                  <div className="cov-pop-row">
                    <span>Shade by</span>
                    <div className="cov-seg">
                      <button className={mapMode === 'assignment' ? 'active' : ''} onClick={() => setMapMode('assignment')}>
                        Progress
                      </button>
                      <button className={mapMode === 'priority' ? 'active' : ''} onClick={() => setMapMode('priority')}>
                        Priority
                      </button>
                    </div>
                  </div>
                </section>

                <section>
                  <header><span>Roads</span></header>
                  {/* One question asked at three scales, so one choice rather than three switches. */}
                  <div className="cov-radio-list" role="radiogroup" aria-label="Which roads to draw">
                    {([
                      ['off', 'None', 'Just the areas and basemap'],
                      ['assigned', 'In assigned areas', 'Every road a crew holds — red to drive'],
                      ['covered', 'Everything driven', 'All driven road, project-wide'],
                      ['all', 'All roads', 'The whole network, every road at full detail'],
                    ] as const).map(([value, label, hint]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={roadScope === value}
                        className={roadScope === value ? 'on' : ''}
                        onClick={() => setRoadScope(value)}
                      >
                        <span className="dot" />
                        <span>
                          <b>{label}</b>
                          <small>{hint}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  {roadScope !== 'off' && (
                    <div className="cov-pop-row">
                      <span>Tint driven roads by driver</span>
                      <Switch checked={colorRoadsByDriver} onChange={setColorRoadsByDriver}>
                        <span className="sr-only">Tint driven roads by driver</span>
                      </Switch>
                    </div>
                  )}
                </section>

                <section>
                  <header>
                    <span>Driven tracks</span>
                    <Switch checked={showTracks} onChange={setShowTracks} title="Snapped routes the fleet actually drove">
                      <span className="sr-only">Show driven tracks</span>
                    </Switch>
                  </header>
                  <div className="cov-presets">
                    {[7, 14, 30].map((d) => (
                      <button
                        key={d}
                        type="button"
                        className={showTracks && activePreset === d ? 'on' : ''}
                        onClick={() => tracksPreset(d)}
                      >
                        Last {d} days
                      </button>
                    ))}
                  </div>
                  <div className="cov-dates">
                    <input
                      type="date"
                      aria-label="Tracks from"
                      value={tracksFrom}
                      max={tracksTo}
                      onChange={(e) => { setTracksFrom(e.target.value); setShowTracks(true); }}
                    />
                    <span>to</span>
                    <input
                      type="date"
                      aria-label="Tracks to"
                      value={tracksTo}
                      min={tracksFrom}
                      onChange={(e) => { setTracksTo(e.target.value); setShowTracks(true); }}
                    />
                  </div>
                </section>

                <section>
                  <header>
                    <span>Drivers</span>
                    <Switch checked={showPositions} onChange={setShowPositions} title="Where each driver left off">
                      <span className="sr-only">Show where drivers left off</span>
                    </Switch>
                  </header>
                  <p className="cov-layer-hint">
                    A pin where each driver’s last drive ended — or where they are now, if they are
                    still out. Refreshes every minute.
                  </p>
                </section>
              </div>
            )}
          </div>

          <button
            type="button"
            className="cov-map-btn icon"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              {isFullscreen
                ? <path d="M6 1v5H1M10 1v5h5M6 15v-5H1M10 15v-5h5" />
                : <path d="M1 6V1h5M15 6V1h-5M1 10v5h5M15 10v5h-5" />}
            </svg>
          </button>
        </div>

        {/* The crew, on the map they are working. Ranked by road driven; the bar is relative to
            the busiest driver, so a 0 km test account reads as exactly that. */}
        {driverViz.legend.length > 0 && (
          crewOpen ? (
            <div className="cov-crew">
              <div className="cov-crew-head">
                <span>Crew <em>{driverViz.legend.length}</em></span>
                {driverFilter.length > 0 && (
                  <button type="button" className="cov-link" onClick={() => setDriverFilter([])}>Show all</button>
                )}
                <button type="button" className="cov-crew-x" onClick={() => setCrewOpen(false)} aria-label="Hide crew">
                  –
                </button>
              </div>
              <div className="cov-crew-list">
                {driverViz.legend.map((d) => {
                  const on = driverFilter.includes(d.id);
                  const dim = driverFilter.length > 0 && !on;
                  const rgb = `rgb(${d.color.join(',')})`;
                  const pos = positionById.get(d.id);
                  return (
                    <div key={d.id} className="cov-crew-item">
                      <button
                        type="button"
                        className={`cov-crew-row${on ? ' on' : ''}${dim ? ' dim' : ''}`}
                        onClick={() => toggleDriver(d.id)}
                        aria-pressed={on}
                        title={on ? 'Stop focusing on this driver' : 'Focus the map on this driver'}
                      >
                        <span className="cov-crew-dot" style={{ background: rgb }} />
                        <span className="cov-crew-name">{d.name}</span>
                        <span className="cov-crew-km">{km(d.meters)} km</span>
                        <span className="cov-crew-bar">
                          <span style={{ width: `${(d.meters / maxCrewMeters) * 100}%`, background: rgb }} />
                        </span>
                        {/* Where they are up to — the same words as their pin and their card. */}
                        {pos && (
                          <span className={`cov-crew-last ${pos.state}`}>
                            {statusText(pos, clock)}
                            {pos.area ? ` · ${pos.area.name}` : ''}
                          </span>
                        )}
                      </button>
                      {/* Its own button, beside the row rather than inside it: the row focuses the
                          map on a driver's work, this goes to where the driver is. */}
                      {pos && (
                        <button
                          type="button"
                          className="cov-crew-loc"
                          onClick={() => locateDriver(pos)}
                          title={`Show where ${d.name} ${pos.state === 'ended' ? 'left off' : 'is'}`}
                          aria-label={`Show where ${d.name} ${pos.state === 'ended' ? 'left off' : 'is'}`}
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                            <circle cx="8" cy="8" r="4.2" />
                            <path d="M8 1v2.6M8 12.4V15M1 8h2.6M12.4 8H15" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <button type="button" className="cov-map-btn cov-crew-pill" onClick={() => setCrewOpen(true)}>
              Crew <span className="cov-badge">{driverFilter.length || driverViz.legend.length}</span>
            </button>
          )
        )}
        <CoverageMap
          versionId={scopeId}
          mode={mapMode}
          height={isFullscreen ? '100vh' : mapHeight}
          focusAreaId={focusAreaId}
          focusNonce={focusNonce}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          driverColorByArea={driverViz.byArea}
          driverNamesByArea={driverViz.namesByArea}
          showAreas={showAreasLayer}
          roadScope={roadScope}
          // Refetch when assignments move or an area is signed off — both change what is drawn.
          assignedKey={`${assignments.length}:${reloadKey}`}
          showTracks={showTracks}
          tracksFrom={tracksFrom}
          tracksTo={tracksTo}
          // With one polygon picked, narrow the tracks to trips recorded while it was assigned —
          // the question stops being "where did the fleet go" and becomes "who drove THIS area".
          tracksAreaId={singleAreaId}
          colorRoadsByDriver={colorRoadsByDriver}
          driverColorById={driverViz.byDriver}
          driverFilter={driverFilter}
          highlightAreaIds={highlightAreaIds}
          onTracksMeta={onTracksMeta}
          areaPopupId={singleAreaId}
          areaPopup={areaCard}
          driverPins={driverPins}
          selectedPinId={pinDriverId}
          onPickPin={onPickPin}
          pinPopup={pinCard}
          pinTrail={pinTrail}
          focusPoint={pinFocus}
        />

        {selectedIds.length > 1 && (
          <div className="cov-selection-bar">
            <div>
              <strong>{selectedIds.length} area{selectedIds.length === 1 ? '' : 's'} selected</strong>
              <span style={{ color: 'var(--muted)' }}>
                {' · '}{km(selectedAreas.reduce((sum, a) => sum + a.targetMeters, 0))} km
                {' · '}{selectedAreas.reduce((sum, a) => sum + a.targetLinks, 0).toLocaleString()} links
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" onClick={() => setSelectedIds([])}>Clear</button>
              {canEdit && (
                <button className="btn" onClick={() => setAssigning(selectedAreas)}>
                  Assign drivers…
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {breakdown && (
        <div className="card cov-breakdown">
          <h3 className="cov-h3">{breakdown.title}</h3>
          <p className="cov-sub">{breakdown.hint}</p>
          <table>
            <thead>
              <tr>
                <th>{breakdown.title === 'By region' ? 'Region' : 'Delivery'}</th>
                <th>Areas</th>
                <th>Target</th>
                <th>Driven</th>
                <th style={{ width: '26%' }}>Progress</th>
                <th>Signed off</th>
                <th>With a driver</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.rows.map((r) => (
                <tr key={r.key} className="cov-row-clickable" onClick={r.pick} title={`Show only ${r.name}`}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.sub}</div>
                  </td>
                  <td>{r.areas.toLocaleString()}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{km(r.targetMeters)} km</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{km(r.coveredMeters)} km</td>
                  <td>
                    <div className="cov-cell">
                      <Bar value={r.coveredMeters} total={r.targetMeters} tone="green" />
                      <span className="cov-pct">{pct(r.coveredMeters, r.targetMeters).toFixed(1)}%</span>
                    </div>
                  </td>
                  <td>{r.completedAreas.toLocaleString()}</td>
                  <td>{r.assignedAreas.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="cov-split">
        <div className="card">
          <h3 className="cov-h3">By priority</h3>
          <p className="cov-sub">
            The customer&apos;s own bands. Confirm what the ordering means before dispatching against it.
          </p>
          <table>
            <thead>
              <tr><th>Band</th><th>Areas</th><th>Target</th><th style={{ width: '34%' }}>Progress</th></tr>
            </thead>
            <tbody>
              {(summary?.byPriority || version.byPriority.map((b) => ({ ...b, coveredMeters: 0, coveredLinks: 0 }))).map((band) => (
                <tr key={band.priority}>
                  <td style={{ fontWeight: 600 }}>P{band.priority}</td>
                  <td>{band.areas?.toLocaleString() ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{km(band.meters)} km</td>
                  <td>
                    <div className="cov-cell">
                      <Bar value={band.coveredMeters} total={band.meters} />
                      <span className="cov-pct">{pct(band.coveredMeters, band.meters).toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 className="cov-h3">By road class</h3>
          <p className="cov-sub">
            Local roads are usually the bulk of the work and the slowest to drive.
          </p>
          <table>
            <thead>
              <tr><th>Class</th><th>Links</th><th>Target</th><th style={{ width: '34%' }}>Progress</th></tr>
            </thead>
            <tbody>
              {(summary?.byFuncClass || version.byFuncClass.map((b) => ({ ...b, coveredMeters: 0, coveredLinks: 0 }))).map((row) => (
                <tr key={String(row.funcClass)}>
                  <td style={{ fontWeight: 600 }}>{FUNC_CLASS_LABEL[String(row.funcClass)] || 'Unclassified'}</td>
                  <td>{row.links.toLocaleString()}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{km(row.meters)} km</td>
                  <td>
                    <div className="cov-cell">
                      <Bar value={row.coveredMeters} total={row.meters} />
                      <span className="cov-pct">{pct(row.coveredMeters, row.meters).toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="cov-table-head">
          <div>
            <h3 className="cov-h3" style={{ margin: 0 }}>All areas</h3>
            <p className="cov-sub" style={{ margin: '2px 0 0' }}>
              {areas.length.toLocaleString()} shown · click a row to find it on the map
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              placeholder="Search area…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 200 }}
            />
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All priorities</option>
              {(summary?.byPriority || version.byPriority).map((b) => (
                <option key={b.priority} value={b.priority}>P{b.priority}</option>
              ))}
            </select>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Region</th>
              <th>Priority</th>
              <th>Links</th>
              <th>Target</th>
              <th>Assigned to</th>
              <th style={{ width: '18%' }}>Progress</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((a) => (
              <tr
                key={a._id}
                className="cov-row-clickable"
                onClick={() => showAreaOnMap(a._id)}
                title={`Show ${a.name} on the map`}
              >
                <td>
                  <div style={{ fontWeight: 600 }}>
                    {a.name}
                    {a.completed && (
                      <span
                        className="badge green"
                        style={{ marginLeft: 6 }}
                        title={`Signed off${a.completedByName ? ` by ${a.completedByName}` : ''}${
                          a.completedAt ? ` on ${new Date(a.completedAt).toLocaleDateString()}` : ''
                        }`}
                      >
                        ✓ Completed
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{a.areaCode}</div>
                </td>
                <td style={{ color: 'var(--muted)' }}>{a.parentName || '—'}</td>
                <td><span className="badge gray">P{a.priority}</span></td>
                <td>{a.targetLinks.toLocaleString()}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{km(a.targetMeters)} km</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    className="cov-assign-cell"
                    onClick={() => setAssigning([a])}
                    title="Assign drivers to this area"
                  >
                    {(driversByArea.get(a._id) || []).length === 0 ? (
                      <span style={{ color: 'var(--muted)' }}>+ assign</span>
                    ) : (
                      (driversByArea.get(a._id) || []).map((d) => (
                        <span key={d.id} className="badge gray" style={{ marginRight: 4 }}>{d.name}</span>
                      ))
                    )}
                  </button>
                </td>
                <td>
                  <div className="cov-cell">
                    <Bar value={a.coveredMeters} total={a.targetMeters} tone="green" />
                    <span className="cov-pct">{pct(a.coveredMeters, a.targetMeters).toFixed(1)}%</span>
                  </div>
                </td>
              </tr>
            ))}
            {areas.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>No areas match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {splitting && (
        <SplitZonesModal
          scopeId={scopeId}
          area={splitting}
          onClose={() => setSplitting(null)}
          onDone={(result) => {
            setSplitting(null);
            // The area is gone; land on its first zone so the map does not show an empty card.
            setSelectedIds(result.zones[0]?._id ? [result.zones[0]._id] : []);
            loadAssignments();
            setReloadKey((n) => n + 1);
            onChanged();
          }}
        />
      )}

      {clearing && (
        <ClearCoverageModal
          scopeId={scopeId}
          detail={clearing}
          onClose={() => setClearing(null)}
          onDone={() => {
            const areaId = clearing.area._id;
            setClearing(null);
            loadDetail(areaId);
            loadAssignments();
            setReloadKey((n) => n + 1);
            onChanged();
          }}
        />
      )}

      {assigning && assigning.length > 0 && (
        <AssignDriversModal
          version={version}
          scopeId={scopeId}
          areas={assigning}
          driversByArea={driversByArea}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null);
            setSelectedIds([]);
            loadAssignments();
          }}
        />
      )}

      {version.counts.orphanLinks > 0 && (
        <p className="cov-sub" style={{ marginTop: 12 }}>
          {version.counts.orphanLinks.toLocaleString()} link(s) ({km(version.orphanMeters)} km) fall
          outside every work area and are {version.targetMeters > version.counts.links ? 'included in' : 'excluded from'} the target.
        </p>
      )}
    </>
  );
}

/* ================================================================= imports */

function ImportsTab({
  projectId,
  canEdit,
  onCommitted,
}: {
  projectId: string;
  canEdit: boolean;
  onCommitted: () => void;
}) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    if (!projectId) return;
    api
      .get<{ jobs: ImportJob[] }>(`/api/network/imports?projectId=${projectId}`)
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]));
  }, [projectId]);

  useEffect(load, [load]);


  return (
    <>
      <div className="cov-table-head" style={{ padding: '0 0 14px' }}>
        <p className="cov-sub" style={{ margin: 0 }}>
          A shapefile is six or seven sibling files, so each layer comes as a single .zip. Choose the
          work areas and the road network together and they load as one delivery — it only stops to
          ask if something is actually wrong. Roads on their own are added to the current areas.
        </p>
        {canEdit && <button className="btn" disabled={!projectId} onClick={() => setCreating(true)}>+ New import</button>}
      </div>

      {creating && (
        <NewImportModal
          projectId={projectId}
          defaultLabel=""
          onClose={() => setCreating(false)}
          onStarted={(jobId) => {
            setCreating(false);
            load();
            setOpenId(jobId);
          }}
        />
      )}

      {jobs.length === 0 && (
        <div className="card empty-state">
          <p style={{ margin: 0, color: 'var(--muted)' }}>No imports yet for this project.</p>
        </div>
      )}

      {jobs.map((job) =>
        openId === job._id ? (
          <ImportDetail
            key={job._id}
            jobId={job._id}
            canEdit={canEdit}
            onClose={() => setOpenId(null)}
            onChanged={() => { load(); onCommitted(); }}
          />
        ) : (
          <div key={job._id} className="card cov-job-row" onClick={() => setOpenId(job._id)}>
            <div>
              <div style={{ fontWeight: 600 }}>{job.label}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {new Date(job.createdAt).toLocaleString()}
                {job.report ? ` · ${job.report.totals.links.toLocaleString()} links · ${km(job.report.totals.targetMeters)} km` : ''}
              </div>
            </div>
            <StatusBadge job={job} />
          </div>
        )
      )}
    </>
  );
}

function StatusBadge({ job }: { job: ImportJob }) {
  const tone =
    job.status === 'ready' ? 'green'
      : job.status === 'failed' ? 'red'
        : job.status === 'awaiting_approval' ? 'amber'
          : 'gray';
  const label = job.status.replace(/_/g, ' ');
  return <span className={`badge ${tone}`}>{label}</span>;
}

function ImportDetail({
  jobId,
  canEdit,
  onClose,
  onChanged,
}: {
  jobId: string;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [uploading, setUploading] = useState<{ layer: string; percent: number } | null>(null);
  const [busy, setBusy] = useState(false);
  /** The file slot a dragged archive is over. */
  const [dragOver, setDragOver] = useState<'boundary' | 'network' | null>(null);
  const boundaryRef = useRef<HTMLInputElement>(null);
  const networkRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const r = await api.get<{ job: ImportJob }>(`/api/network/imports/${jobId}`);
    setJob(r.job);
    return r.job;
  }, [jobId]);

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  // Poll only while the runner actually has work in hand.
  const live = job && ['queued', 'parsing', 'committing'].includes(job.status);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => {
      refresh()
        .then((j) => { if (!['queued', 'parsing', 'committing'].includes(j.status)) onChanged(); })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [live, refresh, onChanged]);

  const upload = async (layer: 'boundary' | 'network', file: File) => {
    setUploading({ layer, percent: 0 });
    try {
      // A draft waits for the other archive and an explicit start. A checked job re-checks at once
      // when both archives are in; with only one, the server holds it so the other can be added.
      const hold = job?.status === 'draft' ? '&hold=1' : '';
      await uploadRaw(`/api/network/imports/${jobId}/file?layer=${layer}${hold}`, file, (percent) =>
        setUploading({ layer, percent })
      );
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try {
      await api.post(`/api/network/imports/${jobId}${path}`, body);
      await refresh();
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api.patch(`/api/network/imports/${jobId}`, body);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Update failed');
    }
  };

  const remove = async () => {
    if (!confirm('Delete this import job and its uploaded archives?')) return;
    try {
      await api.del(`/api/network/imports/${jobId}`);
      onChanged();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  if (!job) return <div className="card">Loading…</div>;

  // Work areas alone are a valid import; the road layer is optional (see networkImport.js).
  // Either archive is enough — roads alone attach to the active version's existing areas.
  const canLoad = Boolean(job.files.boundary.name || job.files.network.name);
  const report = job.report;

  return (
    <div className="card cov-detail">
      <div className="cov-table-head" style={{ padding: 0, marginBottom: 16 }}>
        <div>
          <h3 className="cov-h3" style={{ margin: 0 }}>{job.label}</h3>
          <p className="cov-sub" style={{ margin: '2px 0 0' }}>
            Created {new Date(job.createdAt).toLocaleString()}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <StatusBadge job={job} />
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>

      {job.error && (
        <div className="cov-issue error" style={{ marginBottom: 14 }}>
          <strong>Import failed.</strong> {job.error}
        </div>
      )}

      {live && (
        <div className="cov-progress-live">
          <div className="cov-spinner" />
          <div>
            <strong>{job.progress.phase || job.status}</strong>
            {job.progress.total > 0 && (
              <span style={{ color: 'var(--muted)' }}>
                {' '}— {job.progress.done.toLocaleString()} / {job.progress.total.toLocaleString()}
              </span>
            )}
            {job.progress.total === 0 && job.progress.done > 0 && (
              <span style={{ color: 'var(--muted)' }}> — {job.progress.done.toLocaleString()} features</span>
            )}
          </div>
        </div>
      )}

      {/* ---- files ---- */}
      <div className="cov-split">
        {(['boundary', 'network'] as const).map((layer) => {
          const info = job.files[layer];
          const ref = layer === 'boundary' ? boundaryRef : networkRef;
          const active = uploading?.layer === layer;
          const droppable = canEdit && !live && job.status !== 'ready' && !uploading;
          return (
            <div
              key={layer}
              className={`cov-file${dragOver === layer ? ' over' : ''}`}
              {...dropTarget(
                (files) => {
                  const zip = zipsIn(files)[0];
                  if (zip) upload(layer, zip);
                  else alert('Drop the .zip archive — a shapefile has to be zipped with its sibling files.');
                },
                (o) => setDragOver(o ? layer : null),
                !droppable
              )}
            >
              <div className="cov-file-label">
                {layer === 'boundary'
                  ? 'Work areas (polygons)'
                  : 'Road network (lines)'}
              </div>
              {info.name ? (
                <div className="cov-file-have">
                  <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{info.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {mb(info.bytes)} · sha {info.sha256?.slice(0, 12)}
                  </div>
                </div>
              ) : (
                <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 0' }}>No archive uploaded</div>
              )}
              {active && (
                <div className="cov-bar" style={{ margin: '8px 0' }}>
                  <div className="cov-bar-fill brand" style={{ width: `${uploading.percent}%` }} />
                </div>
              )}
              {canEdit && !live && job.status !== 'ready' && (
                <>
                  <input
                    ref={ref}
                    type="file"
                    accept=".zip,application/zip"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload(layer, f);
                      e.target.value = '';
                    }}
                  />
                  <button className="btn-ghost" disabled={Boolean(uploading)} onClick={() => ref.current?.click()}>
                    {active ? `Uploading ${uploading.percent}%` : info.name ? 'Replace .zip' : 'Choose .zip'}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- actions ---- */}
      {/* Loading starts by itself once both archives are in. Buttons here exist only for the
          cases where it could NOT just proceed: something blocked it, or it failed. */}
      {canEdit && !live && (
        <div className="cov-actions">
          {job.status === 'draft' && !canLoad && (
            <span className="cov-sub" style={{ margin: 0, alignSelf: 'center' }}>
              Choose the work areas and the road network, then start.
            </span>
          )}
          {job.status === 'draft' && canLoad && (
            <>
              <button className="btn" disabled={busy || Boolean(uploading)} onClick={() => act('/validate')}>
                Start import
              </button>
              <span className="cov-sub" style={{ margin: 0, alignSelf: 'center' }}>
                {job.files.boundary.name && job.files.network.name
                  ? 'Both archives are in.'
                  : job.files.boundary.name
                    ? 'Add the road network first if you have it — otherwise the areas load on their own.'
                    : 'Roads only will be added to the current work areas — add the work areas first for a new place.'}
              </span>
            </>
          )}
          {job.status === 'awaiting_approval' && (
            <>
              <button
                className="btn"
                disabled={busy || (report?.errors.length ?? 0) > 0}
                title={report?.errors.length ? 'Fix the blocking problems first' : undefined}
                onClick={() => act('/commit')}
              >
                Load anyway
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => act('/validate')}>
                Re-check
              </button>
            </>
          )}
          {job.status === 'failed' && (
            <button className="btn" disabled={!canLoad || busy} onClick={() => act('/validate')}>
              Retry
            </button>
          )}
          {job.status === 'ready' && (
            <span className="cov-sub" style={{ margin: 0, alignSelf: 'center' }}>
              Loaded and active — see the Progress and Map tabs.
            </span>
          )}
          <button className="btn-danger" onClick={remove}>Delete</button>
        </div>
      )}

      {report && (job.status === 'awaiting_approval' || report.errors.length > 0 || report.warnings.length > 0) && (
        <ReportView job={job} report={report} canEdit={canEdit && !live} onPatch={patch} />
      )}
    </div>
  );
}

/* ================================================================= report */

/**
 * The preflight, deliberately short.
 *
 * An earlier version of this rendered everything the parser knew: coordinate-system tables, the
 * link-length distribution, priority bands, road-class and direction breakdowns, every .dbf column.
 * All of it true, none of it a decision. The operator is answering one question — is this the right
 * delivery, and can it be committed — so what stays is what changes that answer: anything blocking,
 * anything worth a second look, the four numbers that say how big the job is, a map to confirm the
 * areas are actually where they should be, and the two things that are genuinely editable.
 *
 * The distributions did not disappear; they moved to the Progress and Map tabs, where they describe
 * committed data rather than padding a decision screen.
 */
function ReportView({
  job,
  report,
  canEdit,
  onPatch,
}: {
  job: ImportJob;
  report: ImportReport;
  canEdit: boolean;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const [showColumns, setShowColumns] = useState(false);
  const [showChecks, setShowChecks] = useState(false);

  const hasNetwork = report.network !== null;

  const fieldsFor = useMemo(
    // report.network is null for an areas-only import. Reading .fields off it threw during render
    // and took the whole page down with it.
    () => ({ boundary: report.boundary.fields, network: report.network?.fields ?? [] }),
    [report]
  );

  const blocking = report.errors.length;
  const checks = report.warnings.length;

  return (
    <div style={{ marginTop: 22 }}>
      <div className="cov-table-head" style={{ padding: 0, marginBottom: 12 }}>
        <div>
          <h3 className="cov-h3" style={{ margin: 0 }}>Preflight</h3>
          <p className="cov-sub" style={{ margin: '2px 0 0' }}>
            {job.status === 'ready' ? 'Checked and loaded' : 'Nothing has been written yet'} ·{' '}
            {new Date(report.generatedAt).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Blocking problems always show in full — they are the reason commit is disabled. */}
      {report.errors.map((issue) => (
        <div key={issue.code} className="cov-issue error">
          <strong>Blocking</strong> · {issue.message}
        </div>
      ))}

      {blocking === 0 && checks === 0 && (
        <div className="cov-issue ok"><strong>Clean</strong> · Nothing to flag. Ready to commit.</div>
      )}

      {/* Advisories collapse to one line. They are worth reading once, not worth four paragraphs
          between the operator and the commit button every time they open the job. */}
      {checks > 0 && (
        <div className="cov-issue warn">
          <button className="cov-disclosure" onClick={() => setShowChecks((v) => !v)}>
            {showChecks ? '▾' : '▸'} {checks} thing{checks === 1 ? '' : 's'} worth checking
            {!showChecks && blocking === 0 && ' — none of them block the import'}
          </button>
          {showChecks && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {report.warnings.map((issue) => (
                <li key={issue.code} style={{ marginBottom: 5 }}>{issue.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="stat-row" style={{ marginTop: 14 }}>
        <div className="stat"><div className="v">{report.totals.areas.toLocaleString()}</div><div className="k">Work areas</div></div>
        <div className="stat"><div className="v">{report.totals.links.toLocaleString()}</div><div className="k">Road links</div></div>
        <div className="stat"><div className="v">{km(report.totals.targetMeters)} km</div><div className="k">Target</div></div>
        <div className="stat"><div className="v">{report.boundary.byPriority.length}</div><div className="k">Priority bands</div></div>
      </div>

      {/* The check no table can do: are these areas in the right place at all. */}
      <p className="cov-sub" style={{ marginTop: 16 }}>
        Work areas as they will be imported, shaded by priority band. Road links appear on the Map
        tab once this is committed.
      </p>
      <CoverageMap importJobId={job._id} mode="priority" height={420} />

      <details
        className="cov-details"
        open={showColumns}
        onToggle={(e) => setShowColumns((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          Column mapping
          <span className="cov-details-hint">
            {report.mapping.areaCode || '—'} · {report.mapping.linkId || '—'} · {report.mapping.priority || 'no priority'}
          </span>
        </summary>
        <p className="cov-sub" style={{ marginTop: 10 }}>
          Detected from the .dbf headers. Override before committing — the next delivery will not
          necessarily use the same column names.
          {!hasNetwork && ' Road-network columns are hidden because no road archive was uploaded.'}
        </p>
        <div className="cov-mapping">
          {MAPPING_FIELDS.filter((f) => f.layer === 'boundary' || hasNetwork).map(({ key, label, layer, required }) => (
            <label key={key} className="field">
              <span>
                {label}
                {required && <b style={{ color: 'var(--red)' }}> *</b>}
                <em style={{ color: 'var(--muted)', fontStyle: 'normal', fontWeight: 400 }}> · {layer}</em>
              </span>
              <select
                className="input"
                disabled={!canEdit}
                value={job.mapping[key] || ''}
                onChange={(e) => onPatch({ mapping: { [key]: e.target.value || null } })}
              >
                <option value="">— none —</option>
                {fieldsFor[layer].map((f) => (
                  <option key={f.name} value={f.name}>{f.name} ({f.type}{f.length})</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </details>

      {report.join.orphanLinks > 0 && (
        <label className="cov-toggle">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={job.includeOrphanLinks}
            onChange={(e) => onPatch({ includeOrphanLinks: e.target.checked })}
          />
          <span>
            Count the {report.join.orphanLinks.toLocaleString()} link(s) outside every work area
            ({km(report.join.orphanMeters)} km) toward the target. They are imported either way —
            this only decides whether they are part of the denominator.
          </span>
        </label>
      )}

      {/* Offered whenever area codes repeat: either the file is a merge of several layers (copies —
          keep the first), or each row is a PIECE of one area (HERE Admin4 — join them). Only the
          operator knows which; changing it re-checks the files. */}
      {(job.joinAreaParts || report.joinAreaParts || report.warnings.some((w) => w.code === 'DUPLICATE_AREA_CODE' || w.code === 'JOINED_AREA_PARTS')) && (
        <label className="cov-toggle">
          <input
            type="checkbox"
            disabled={!canEdit}
            // What the check actually did: the operator's choice, or the default for this kind of
            // file (on for HERE Admin layers) until they make one.
            checked={Boolean(report.joinAreaParts ?? job.joinAreaParts)}
            onChange={(e) => onPatch({ joinAreaParts: e.target.checked })}
          />
          <span>
            Rows that share an area code are <b>pieces of one area</b> (islands, slivers, split
            parts) — join them into one area. Leave off when the file is several layers merged
            together and the repeats are copies. Changing this re-checks the files.
          </span>
        </label>
      )}
      {/* A re-delivery brings back, whole, an area this project has already split into zones.
          Kept split by default — the zones are what drivers are assigned to. */}
      {(job.keepAreaSplits === false || (report.split?.length ?? 0) > 0) && (
        <label className="cov-toggle">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={job.keepAreaSplits !== false}
            onChange={(e) => onPatch({ keepAreaSplits: e.target.checked })}
          />
          <span>
            Keep areas that were <b>split into zones</b> earlier in this project split
            {report.split?.length
              ? ` (${report.split.map((s) => `${s.name}: ${s.zones.length} zones`).slice(0, 3).join(', ')})`
              : ''}
            . The zones keep their codes, so drivers and sign-offs stay attached. Untick to import
            those areas whole, as delivered. Changing this re-checks the files.
          </span>
        </label>
      )}
    </div>
  );
}

/* ================================================================= assignment */

/**
 * Set which drivers are responsible for one work area.
 *
 * A multi-select rather than one-driver-per-area: a 1,400 km² rural SA2 is realistically shared
 * between crews, while a dense urban one is one person's morning. The backend treats the result as
 * a set — drivers removed here are released and kept as history, never deleted.
 */
function AssignDriversModal({
  version,
  scopeId,
  areas,
  driversByArea,
  onClose,
  onSaved,
}: {
  version: NetworkVersion;
  /** Project scope, so areas from any of its deliveries can be assigned in one call. */
  scopeId: string;
  /** One area from the table, or a whole cluster picked on the map. */
  areas: CoverageArea[];
  driversByArea: Map<string, { id: string; name: string }[]>;
  onClose: () => void;
  onSaved: () => void;
}) {
  /**
   * Pre-tick only drivers who hold EVERY selected area.
   *
   * Saving replaces the assignment on all of them, so anyone shown as ticked must really be on
   * all of them — pre-ticking someone who holds just one would silently spread them across the
   * whole selection the moment you pressed save.
   */
  const commonDrivers = useMemo(() => {
    if (!areas.length) return [];
    const lists = areas.map((a) => new Set((driversByArea.get(a._id) || []).map((d) => d.id)));
    return [...lists[0]].filter((id) => lists.every((set) => set.has(id)));
  }, [areas, driversByArea]);

  const [drivers, setDrivers] = useState<User[]>([]);
  // One area belongs to one driver, so this is a single choice, not a set. Kept as an array
  // because the endpoint takes driverIds — and because releasing is "nobody", i.e. empty.
  const [selected, setSelected] = useState<string[]>(commonDrivers.slice(0, 1));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by a refusal the server says this user may force past — only ever a completed area.
  const [canOverride, setCanOverride] = useState(false);

  useEffect(() => {
    const projectId =
      typeof version.projectId === 'object' ? version.projectId._id : version.projectId;
    // Scoped to the project this network belongs to. The backend enforces the same rule on save,
    // so another customer's crew cannot be assigned even by a crafted request.
    api
      .get<{ users: User[] }>(`/api/users?role=user&projectId=${projectId}`)
      .then((r) => setDrivers(r.users || []))
      .catch(() => setDrivers([]));
  }, [version.projectId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? drivers.filter((d) => d.name.toLowerCase().includes(q)) : drivers;
    // Selected first, so what you have already chosen never scrolls out of sight behind a filter.
    return [...rows].sort((a, b) => {
      const sa = selected.includes(a._id) ? 0 : 1;
      const sb = selected.includes(b._id) ? 0 : 1;
      return sa - sb || a.name.localeCompare(b.name);
    });
  }, [drivers, query, selected]);

  /** Picking a driver replaces whoever was picked; picking the same one again releases the area. */
  const toggle = (id: string) => setSelected((prev) => (prev[0] === id ? [] : [id]));

  const save = async (override = false) => {
    setBusy(true);
    setError(null);
    setCanOverride(false);
    try {
      // One request for the whole selection — see bulkAssign in network.controller.js.
      await api.put(`/api/network/versions/${scopeId}/assignments`, {
        areaIds: areas.map((a) => a._id),
        driverIds: selected,
        mode: 'set',
        ...(override ? { override: true } : {}),
      });
      onSaved();
    } catch (e) {
      // A 409 is a rule, not a failure: the area is signed off, or it already has a driver. The
      // body says which, and whether this user is allowed to force past it.
      const body = (e as ApiError).body as
        | { blockers?: { reason: string }[]; canOverride?: boolean; hint?: string }
        | undefined;
      if (body?.blockers?.length) {
        setCanOverride(body.canOverride === true);
        setError(
          `${e instanceof Error ? e.message : 'Blocked'}${body.hint ? ` — ${body.hint}` : ''}`
        );
        return;
      }
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={areas.length === 1 ? `Assign · ${areas[0].name}` : `Assign · ${areas.length} areas`}
      onClose={onClose}
    >
      <p className="cov-sub" style={{ marginTop: 0 }}>
        {areas.length === 1
          ? `${areas[0].areaCode} · P${areas[0].priority} · `
          : `${areas.map((a) => a.name).slice(0, 3).join(', ')}${areas.length > 3 ? ` +${areas.length - 3} more` : ''} · `}
        {km(areas.reduce((sum, a) => sum + a.targetMeters, 0))} km across{' '}
        {areas.reduce((sum, a) => sum + a.targetLinks, 0).toLocaleString()} links
      </p>
      {areas.some((a) => a.coveredMeters > 0) && (
        <div className="cov-issue warn" style={{ marginBottom: 10 }}>
          {km(areas.reduce((sum, a) => sum + a.coveredMeters, 0))} km here is already marked driven —
          coverage belongs to whoever drove a road first, so the driver will see those roads as done.
          To have {areas.length === 1 ? 'it' : 'an area'} driven again from zero, use
          {' '}<b>Clear driven data</b> on the area’s card first.
        </div>
      )}
      {areas.length > 1 && commonDrivers.length === 0 &&
        areas.some((a) => (driversByArea.get(a._id) || []).length > 0) && (
        <div className="cov-issue warn" style={{ marginBottom: 10 }}>
          These areas currently have different drivers. Saving replaces the assignment on all
          {' '}{areas.length} with whatever you pick here.
        </div>
      )}

      <input
        className="input"
        placeholder="Search drivers…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 10 }}
      />

      <div className="cov-driver-list">
        {visible.map((d) => (
          <label key={d._id} className="cov-driver-row">
            <input
              type="radio"
              name="assign-driver"
              checked={selected.includes(d._id)}
              // onChange never fires for the already-checked radio, and clicking the current
              // choice again is how an area is released — so the clear lives on click.
              onChange={() => toggle(d._id)}
              onClick={() => { if (selected[0] === d._id) toggle(d._id); }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{d.name}</span>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {d.email}</span>
            </span>
          </label>
        ))}
        {visible.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: 8 }}>
            {drivers.length === 0 ? 'No drivers on this project yet.' : 'No drivers match.'}
          </p>
        )}
      </div>

      {error && <div className="cov-issue error" style={{ marginTop: 10 }}>{error}</div>}

      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        {canOverride && (
          <button className="btn-ghost" disabled={busy} onClick={() => save(true)}>
            Assign anyway
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => save()}>
          {busy ? 'Saving…' : selected.length === 0 ? 'Release area' : 'Assign driver'}
        </button>
      </div>
    </Modal>
  );
}
