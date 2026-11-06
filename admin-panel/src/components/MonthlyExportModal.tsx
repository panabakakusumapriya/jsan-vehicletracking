import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { viewerTimeZone } from '../lib/api';
import { clockText, runExportJob, timeLeftText, type ExportJobStatus, type ExportProgress } from '../lib/exportJobs';

/**
 * A region's whole month in one download: every driver's raw GPS merged into one KML, their
 * cleaned (road-snapped) routes into another, and a per-driver-per-day summary CSV — in a zip.
 * Built in the background on the server (services/monthExport.js), with progress here.
 *
 * Driver → Day folders in both files, one colour per driver; opens in Google Earth, QGIS, ArcGIS.
 */

type Layers = 'both' | 'raw' | 'cleaned';

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;

/**
 * Where the export is up to, with the time left: step 1 the server builds the files (trips done
 * of total), step 2 the zip comes down (MB of MB, speed). The time left is measured from the
 * speed so far and counts down every second between updates.
 */
function ExportProgressPanel({ p, now }: { p: ExportProgress; now: number }) {
  const left = timeLeftText(p.finishBy, now);
  let step = 1;
  let title = 'Starting…';
  let pct: number | null = 0;
  let detail = '';
  if (p.phase === 'queued') {
    title = p.waiting ? 'Waiting for another export to finish' : 'Starting…';
    detail = p.waiting ? 'One export is built at a time — yours starts as soon as the one before it is done.' : '';
  } else if (p.phase === 'building') {
    title = 'Building the files on the server';
    pct = p.total ? p.done / p.total : 0;
    detail = `${p.done.toLocaleString()} of ${p.total.toLocaleString()} trips · ${left ?? 'working out the time left…'}`;
  } else if (p.phase === 'packing') {
    title = 'Packing the zip';
    pct = null;
    detail = `All ${p.total.toLocaleString()} trips written — compressing and storing the file. Nearly there.`;
  } else {
    step = 2;
    title = 'Downloading';
    pct = p.bytes ? p.received / p.bytes : null;
    detail = [
      p.bytes ? `${mb(p.received)} of ${mb(p.bytes)}` : mb(p.received),
      p.bytesPerSec ? `${mb(p.bytesPerSec)}/s` : null,
      left ?? (p.bytes ? 'working out the time left…' : null),
    ].filter(Boolean).join(' · ');
  }
  return (
    <div style={{ marginTop: 14, padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel-2)' }}>
      <style>{`@keyframes mx-slide { from { background-position: 0 0; } to { background-position: 40px 0; } }`}</style>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Step {step} of 2</span>
        <b style={{ fontSize: 14, flex: 1 }}>{title}</b>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }} title="Time since you started this export">
          {clockText(now - p.startedAt)}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 99, background: 'var(--line)', overflow: 'hidden', marginTop: 10 }}>
        {pct == null ? (
          // Size or end not known (packing, or a download without a length): moving stripes.
          <div style={{ height: '100%', width: '100%', background: 'repeating-linear-gradient(45deg, var(--brand) 0 10px, var(--brand-light, #c7d2fe) 10px 20px)', animation: 'mx-slide 0.8s linear infinite' }} />
        ) : (
          <div style={{ height: '100%', width: `${Math.min(100, Math.round(pct * 100))}%`, background: 'var(--brand)', transition: 'width 0.4s ease' }} />
        )}
      </div>
      {detail && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>{detail}</div>}
    </div>
  );
}

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
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportJobStatus | null>(null);
  // A clock for the countdown and the elapsed time, ticking only while an export runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

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
    setNow(Date.now());
    setProgress({ phase: 'queued', done: 0, total: 0, received: 0, bytes: 0, bytesPerSec: 0, finishBy: null, startedAt: Date.now(), waiting: false });
    try {
      const job = await runExportJob(
        { format: 'kml', layer: 'raw', kind: 'month', month, country: region || undefined, layers, tz: viewerTimeZone() },
        undefined,
        (p) => { setProgress(p); setNow(Date.now()); },
        // A whole region's month can take a while to build; do not give up at the usual 30 min.
        { timeoutMs: 90 * 60 * 1000 }
      );
      setResult(job);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed');
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  const monthLabel = (() => {
    const [y, m] = month.split('-').map(Number);
    return y && m ? new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : month;
  })();

  return (
    <Modal title="Monthly export" onClose={onClose}>
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
        minutes and be tens of MB — the time left is shown as it goes, and the download starts by
        itself (even if you close this window).
      </p>

      {progress && <ExportProgressPanel p={progress} now={now} />}
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
        <button className="btn-ghost" onClick={onClose} title={busy ? 'The export carries on and downloads by itself' : undefined}>
          {busy ? 'Hide' : 'Close'}
        </button>
        <button className="btn" onClick={build} disabled={busy || !/^\d{4}-\d{2}$/.test(month)}>
          {busy ? 'Building…' : `Build ${monthLabel}`}
        </button>
      </div>
    </Modal>
  );
}
