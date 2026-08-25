import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoverageMap } from '../components/CoverageMap';
import { Modal } from '../components/Modal';
import { api, uploadRaw } from '../lib/api';
import { useAuth } from '../lib/auth';
import type {
  AreaAssignment,
  ColumnMapping,
  CoverageArea,
  CoverageSummary,
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
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

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

function Bar({ value, total, tone = 'brand' }: { value: number; total: number; tone?: 'brand' | 'green' }) {
  const p = Math.min(100, pct(value, total));
  return (
    <div className="cov-bar" title={`${p.toFixed(1)}%`}>
      <div className={`cov-bar-fill ${tone}`} style={{ width: `${p}%` }} />
    </div>
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

  useEffect(() => {
    api
      .get<{ projects: Project[] }>('/api/projects')
      .then((r) => {
        setProjects(r.projects);
        if (r.projects.length && !projectId) setProjectId(r.projects[0]._id);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const version = versions.find((v) => v._id === versionId) || null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Coverage</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Progress against the road network the customer requires driven
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
          </select>
          {versions.length > 0 && (
            <select className="input" value={versionId} onChange={(e) => setVersionId(e.target.value)} style={{ width: 'auto' }}>
              {versions.map((v) => (
                <option key={v._id} value={v._id}>
                  {v.label}{v.status === 'active' ? ' · active' : ` · ${v.status}`}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)', marginBottom: 16 }}>{error}</div>}

      <div className="cov-tabs">
        <button className={tab === 'progress' ? 'active' : ''} onClick={() => setTab('progress')}>Work areas</button>
        <button className={tab === 'imports' ? 'active' : ''} onClick={() => setTab('imports')}>
          Network imports
        </button>
      </div>

      {tab === 'progress' &&
        (version ? (
          <ProgressTab version={version} onChanged={loadVersions} canEdit={canEdit} />
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
  onChanged,
  canEdit,
}: {
  version: NetworkVersion;
  onChanged: () => void;
  canEdit: boolean;
}) {
  const [summary, setSummary] = useState<CoverageSummary | null>(null);
  const [areas, setAreas] = useState<CoverageArea[]>([]);
  const [priority, setPriority] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [assignments, setAssignments] = useState<AreaAssignment[]>([]);
  const [assigning, setAssigning] = useState<CoverageArea[] | null>(null);
  const [mapMode, setMapMode] = useState<'coverage' | 'priority' | 'driver'>('driver');
  // Areas picked on the map, waiting to be handed to a driver. Territory is carved
  // geographically, so the selection lives on the map rather than in the table.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Which area the map is framing. The areas are six clusters spread across 295 x 263 km, so the
  // all-areas view is mostly empty space — picking a row has to take the camera there.
  const [focusAreaId, setFocusAreaId] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  const showAreaOnMap = useCallback((areaId: string) => {
    setFocusAreaId(areaId);
    mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  /** Plain click replaces the selection; shift/ctrl-click builds a cluster up one area at a time. */
  const toggleSelect = useCallback((areaId: string, additive: boolean) => {
    setSelectedIds((prev) => {
      if (!additive) return prev.length === 1 && prev[0] === areaId ? [] : [areaId];
      return prev.includes(areaId) ? prev.filter((id) => id !== areaId) : [...prev, areaId];
    });
  }, []);

  const loadAssignments = useCallback(() => {
    api
      .get<{ assignments: AreaAssignment[] }>(`/api/network/versions/${version._id}/assignments`)
      .then((r) => setAssignments(r.assignments))
      .catch(() => setAssignments([]));
  }, [version._id]);

  useEffect(loadAssignments, [loadAssignments]);

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
      .get<{ coverage: CoverageSummary }>(`/api/network/versions/${version._id}`)
      .then((r) => setSummary(r.coverage))
      .catch(() => setSummary(null));
  }, [version._id]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (priority !== '') params.set('priority', priority);
    if (query.trim()) params.set('q', query.trim());
    const t = setTimeout(() => {
      api
        .get<{ areas: CoverageArea[] }>(`/api/network/versions/${version._id}/areas?${params}`)
        .then((r) => setAreas(r.areas))
        .catch(() => setAreas([]));
    }, 250);
    return () => clearTimeout(t);
  }, [version._id, priority, query]);

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
  const driverColorByArea = useMemo(() => {
    const PALETTE: [number, number, number][] = [
      [124, 58, 237], [37, 99, 235], [5, 150, 105], [217, 119, 6],
      [219, 39, 119], [8, 145, 178], [132, 204, 22], [239, 68, 68],
      [99, 102, 241], [20, 184, 166], [234, 88, 12], [168, 85, 247],
    ];
    const ids = [...new Set(assignments.map((a) =>
      typeof a.driverId === 'object' && a.driverId ? a.driverId._id : String(a.driverId)
    ))].sort();
    const colorFor = new Map(ids.map((id, i) => [id, PALETTE[i % PALETTE.length]]));
    const out: Record<string, [number, number, number]> = {};
    for (const a of assignments) {
      const id = typeof a.driverId === 'object' && a.driverId ? a.driverId._id : String(a.driverId);
      // First holder wins the colour when an area is shared — the fill can only show one.
      if (!out[String(a.areaId)]) out[String(a.areaId)] = colorFor.get(id)!;
    }
    return out;
  }, [assignments]);

  const selectedAreas = useMemo(
    () => areas.filter((a) => selectedIds.includes(a._id)),
    [areas, selectedIds]
  );

  const covered = summary?.coveredMeters || 0;
  const target = version.targetMeters;
  const remaining = Math.max(0, target - covered);

  return (
    <>
      {version.status !== 'active' && canEdit && (
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

      <div className="stat-row">
        <div className="stat"><div className="v">{km(target)} km</div><div className="k">Target</div></div>
        <div className="stat"><div className="v">{km(covered)} km</div><div className="k">Covered</div></div>
        <div className="stat"><div className="v">{pct(covered, target).toFixed(1)}%</div><div className="k">Complete</div></div>
        <div className="stat"><div className="v">{km(remaining)} km</div><div className="k">Remaining</div></div>
        <div className="stat"><div className="v">{version.counts.areas.toLocaleString()}</div><div className="k">Work areas</div></div>
        <div className="stat"><div className="v">{version.counts.links.toLocaleString()}</div><div className="k">Road links</div></div>
      </div>

      {/* The map is the view, not a place you navigate to. Everything below is the same data as
          a table, for the questions a picture cannot answer. */}
      <div
        ref={mapRef}
        className="card"
        style={{ padding: 0, marginBottom: 16, overflow: 'hidden', position: 'relative' }}
      >
        <div className="cov-table-head">
          <div>
            <h3 className="cov-h3" style={{ margin: 0 }}>Work areas</h3>
            <p className="cov-sub" style={{ margin: '2px 0 0' }}>
              {mapMode === 'driver'
                ? 'Shaded by who is responsible — click areas to assign them'
                : mapMode === 'coverage'
                  ? 'Shaded by how much of each area is driven'
                  : "Shaded by the customer's priority band"}
              {' · zoom in to load the roads themselves'}
            </p>
          </div>
          <div className="cov-tabs" style={{ border: 'none', margin: 0 }}>
            <button className={mapMode === 'driver' ? 'active' : ''} onClick={() => setMapMode('driver')}>Driver</button>
            <button className={mapMode === 'coverage' ? 'active' : ''} onClick={() => setMapMode('coverage')}>Coverage</button>
            <button className={mapMode === 'priority' ? 'active' : ''} onClick={() => setMapMode('priority')}>Priority</button>
          </div>
        </div>
        <CoverageMap
          versionId={version._id}
          mode={mapMode}
          height={560}
          focusAreaId={focusAreaId}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          driverColorByArea={driverColorByArea}
        />

        {selectedIds.length > 0 && (
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
              {version.byPriority.map((b) => (
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
                  <div style={{ fontWeight: 600 }}>{a.name}</div>
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

      {assigning && assigning.length > 0 && (
        <AssignDriversModal
          version={version}
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

  const create = async () => {
    setCreating(true);
    try {
      const r = await api.post<{ job: ImportJob }>('/api/network/imports', { projectId });
      load();
      setOpenId(r.job._id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create import');
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="cov-table-head" style={{ padding: '0 0 14px' }}>
        <p className="cov-sub" style={{ margin: 0 }}>
          A shapefile is six or seven sibling files, so upload each layer as a single .zip. The
          work areas are enough to start — loading begins as soon as they are in, and it only stops
          to ask if something is actually wrong. The road network is optional and adds coverage
          tracking; you can add it later.
        </p>
        {canEdit && <button className="btn" disabled={creating || !projectId} onClick={create}>+ New import</button>}
      </div>

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
      await uploadRaw(`/api/network/imports/${jobId}/file?layer=${layer}`, file, (percent) =>
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
  const canLoad = Boolean(job.files.boundary.name);
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
          return (
            <div key={layer} className="cov-file">
              <div className="cov-file-label">
                {layer === 'boundary'
                  ? 'Work areas (polygons)'
                  : 'Road network (lines) — optional'}
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
          {job.status === 'draft' && !job.files.boundary.name && (
            <span className="cov-sub" style={{ margin: 0, alignSelf: 'center' }}>
              Add the work-area archive and loading starts automatically.
            </span>
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

  const fieldsFor = useMemo(
    () => ({ boundary: report.boundary.fields, network: report.network.fields }),
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
            Nothing has been written yet · {new Date(report.generatedAt).toLocaleString()}
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
        </p>
        <div className="cov-mapping">
          {MAPPING_FIELDS.map(({ key, label, layer, required }) => (
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
  areas,
  driversByArea,
  onClose,
  onSaved,
}: {
  version: NetworkVersion;
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
  const [selected, setSelected] = useState<string[]>(commonDrivers);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // One request for the whole selection — see bulkAssign in network.controller.js.
      await api.put(`/api/network/versions/${version._id}/assignments`, {
        areaIds: areas.map((a) => a._id),
        driverIds: selected,
        mode: 'set',
      });
      onSaved();
    } catch (e) {
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
              type="checkbox"
              checked={selected.includes(d._id)}
              onChange={() => toggle(d._id)}
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
        <button className="btn" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : `Assign ${selected.length} driver${selected.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  );
}
