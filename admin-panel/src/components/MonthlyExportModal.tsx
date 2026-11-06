import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { viewerTimeZone } from '../lib/api';
import { describeJob, runExportJob, type ExportJobStatus } from '../lib/exportJobs';

/**
 * A region's whole month in one download: every driver's raw GPS merged into one KML, their
 * cleaned (road-snapped) routes into another, and a per-driver-per-day summary CSV — in a zip.
 * Built in the background on the server (services/monthExport.js), with progress here.
 *
 * Driver → Day folders in both files, one colour per driver; opens in Google Earth, QGIS, ArcGIS.
 */

type Layers = 'both' | 'raw' | 'cleaned';

/** The month before this one, as YYYY-MM — a month report is usually for the month just closed. */
function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function MonthlyExportModal({
  regions,
  initialRegion,
  onClose,
}: {
  /** Region names to offer (drivers' countries). */
  regions: string[];
  initialRegion: string;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(lastMonth);
  const [region, setRegion] = useState(initialRegion);
  const [layers, setLayers] = useState<Layers>('both');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportJobStatus | null>(null);

  // Drivers' countries arrive in mixed case ("Australia", "australia"): one choice per region.
  const choices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of regions) if (r && !seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [regions]);

  const build = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus('Queued…');
    let last: ExportJobStatus | null = null;
    try {
      await runExportJob(
        { format: 'kml', layer: 'raw', kind: 'month', month, country: region || undefined, layers, tz: viewerTimeZone() },
        (job) => {
          last = job;
          setStatus(describeJob(job));
        }
      );
      setResult(last);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed');
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const monthLabel = (() => {
    const [y, m] = month.split('-').map(Number);
    return y && m ? new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : month;
  })();

  return (
    <Modal title="Monthly export" onClose={busy ? () => {} : onClose}>
      <p style={{ marginTop: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
        Every driver of a region for one month, merged into one zip: all their <b>raw GPS</b> in one
        file and all their <b>cleaned roads</b> in another, organised by driver and then by day, plus
        a summary sheet. Opens in Google Earth, QGIS or ArcGIS.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ fontSize: 12.5, fontWeight: 600 }}>
          Month
          <input className="input" type="month" value={month} max={new Date().toISOString().slice(0, 7)}
            onChange={(e) => setMonth(e.target.value)} disabled={busy} style={{ marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12.5, fontWeight: 600 }}>
          Region
          <select className="input" value={region} onChange={(e) => setRegion(e.target.value)} disabled={busy} style={{ marginTop: 4 }}>
            <option value="">All regions</option>
            {choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      <div style={{ marginTop: 12, fontSize: 12.5, fontWeight: 600 }}>Include</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6, fontSize: 13 }}>
        {([
          ['both', 'Raw GPS + cleaned roads'],
          ['raw', 'Raw GPS only'],
          ['cleaned', 'Cleaned roads only'],
        ] as [Layers, string][]).map(([v, label]) => (
          <label key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: busy ? 'default' : 'pointer' }}>
            <input type="radio" name="month-layers" checked={layers === v} onChange={() => setLayers(v)} disabled={busy} />
            {label}
          </label>
        ))}
      </div>

      <p style={{ color: 'var(--muted)', fontSize: 12, margin: '12px 0 0' }}>
        A trip belongs to the month by its local date. A busy month for a large region can take a few
        minutes and be tens of MB — keep this window open; the download starts by itself.
      </p>

      {status && (
        <div className="cov-issue" style={{ marginTop: 12 }}>{status}</div>
      )}
      {error && <div className="cov-issue error" style={{ marginTop: 12 }}>{error}</div>}
      {result && (
        <div className="cov-issue" style={{ marginTop: 12, background: 'var(--green-bg, #ecfdf5)', color: 'var(--green, #047857)' }}>
          Downloaded {monthLabel}{region ? ` · ${region}` : ' · all regions'}: {result.total.toLocaleString()} trips
          {result.bytes ? ` (${(result.bytes / 1e6).toFixed(1)} MB)` : ''}.
          {layers !== 'raw' && result.fellBackToRaw > 0 && (
            <> {result.fellBackToRaw.toLocaleString()} trip{result.fellBackToRaw === 1 ? ' has' : 's have'} no cleaned road yet, so
            {result.fellBackToRaw === 1 ? ' it is' : ' they are'} only in the raw GPS file.</>
          )}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        <button className="btn" onClick={build} disabled={busy || !/^\d{4}-\d{2}$/.test(month)}>
          {busy ? 'Building…' : `Build ${monthLabel}`}
        </button>
      </div>
    </Modal>
  );
}
