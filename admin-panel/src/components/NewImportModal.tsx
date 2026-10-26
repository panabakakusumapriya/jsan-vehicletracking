import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Modal } from './Modal';
import { api, uploadRaw } from '../lib/api';
import { zipFiles } from '../lib/storeZip';
import type { ImportJob } from '../lib/types';

type Layer = 'boundary' | 'network';

const LAYER_LABEL: Record<Layer, string> = {
  boundary: 'Work areas (polygons)',
  network: 'Road network (lines)',
};

/**
 * Which slot a dropped zip belongs in, from its name alone — a guess the operator can swap. The
 * customer's files say it: "CHC_Admin4", "Auckland_Admin4_Polygon", "Qld boundaries" are areas;
 * "CHC_FC345_Nav", "QLD" roads files carry Nav / FC / road / link / network.
 */
function guessLayer(name: string): Layer | null {
  const n = name.toLowerCase();
  if (/(admin|polygon|boundar|area|zone|suburb|sa2)/.test(n)) return 'boundary';
  if (/(nav|fc\d|road|link|network|street|line)/.test(n)) return 'network';
  return null;
}

/** The .zip files in a drop or a file dialog — anything else (a stray .shp, a folder) is not an archive. */
export const zipsIn = (list: FileList | File[] | null | undefined) =>
  [...(list || [])].filter((f) => /.zip$/i.test(f.name) || f.type.includes('zip'));

/** Drag-and-drop handlers for an element: highlight while a file is over it, hand over the drop. */
export function dropTarget(onFiles: (files: File[]) => void, setOver: (over: boolean) => void, disabled = false) {
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  return {
    onDragEnter: (e: React.DragEvent) => { if (!disabled && hasFiles(e)) { e.preventDefault(); setOver(true); } },
    onDragOver: (e: React.DragEvent) => { if (!disabled && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e: React.DragEvent) => {
      // Leaving for a child of the same zone is not leaving.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      onFiles([...e.dataTransfer.files]);
    },
  };
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * Start a delivery with BOTH archives chosen up front, then one import.
 *
 * Uploading one archive used to start loading at once. Christchurch's work areas went in as a
 * delivery of their own the moment they finished uploading, and its roads then needed a second
 * import. Here both files are picked first — together, from one file dialog, or one at a time — and
 * sent with `hold=1`; the import starts once, after the last one is in.
 */
export function NewImportModal({
  projectId,
  defaultLabel,
  onClose,
  onStarted,
}: {
  projectId: string;
  defaultLabel: string;
  onClose: () => void;
  /** The job, uploaded and started (or left as a draft if something failed part-way). */
  onStarted: (jobId: string) => void;
}) {
  const [label, setLabel] = useState(defaultLabel);
  /** Roads may be several zips — one per road class (Wellington: FC1-2, FC3, FC4, FC5). */
  const [files, setFiles] = useState<{ boundary: File | null; network: File[] }>({ boundary: null, network: [] });
  /**
   * Roads with no polygons: draw zones from the roads, of this size. On by default — a roads-only
   * delivery for ground already loaded is the rarer case, and is one untick away.
   */
  const [draw, setDraw] = useState({ on: true, minKm: '250', maxKm: '300', absorbRemainder: true });
  const [progress, setProgress] = useState<{ layer: Layer; percent: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which drop zone a dragged file is over: 'both', a layer, or none. */
  const [over, setOver] = useState<'both' | Layer | null>(null);
  /** A drop of something that is not a .zip, said rather than silently ignored. */
  const dropped = (files: File[], then: (zips: File[]) => void) => {
    const zips = zipsIn(files);
    if (!zips.length) {
      setError('Drop the .zip archives — a shapefile has to be zipped with its sibling files.');
      return;
    }
    setError(null);
    then(zips);
  };
  const bothRef = useRef<HTMLInputElement>(null);

  // A zip dropped a little outside the zones must not make the browser leave the page to open it.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);
  const oneRef = useRef<Record<Layer, HTMLInputElement | null>>({ boundary: null, network: null });

  /**
   * Zips from a file dialog or a drop, each to the slot its name suggests: one work-area archive,
   * and any number of road archives. A name that says neither fills the work-area slot when that is
   * empty and nothing else claims it, else joins the roads.
   */
  const place = (picked: File[]) => {
    if (!picked.length) return;
    setFiles((cur) => {
      let boundary = cur.boundary;
      const network = [...cur.network];
      const guesses = picked.map((f) => guessLayer(f.name));
      const claimsAreas = guesses.includes('boundary');
      picked.forEach((f, i) => {
        const g = guesses[i];
        if (g === 'boundary' || (g === null && !boundary && !claimsAreas)) boundary = f;
        else if (!network.some((n) => n.name === f.name && n.size === f.size)) network.push(f);
      });
      return { boundary, network };
    });
  };

  /** Only for one file each way: which is which. */
  const swap = () => setFiles((f) => (f.network.length === 1 ? { boundary: f.network[0], network: f.boundary ? [f.boundary] : [] } : f));

  const roadsOnly = !files.boundary && files.network.length > 0;
  const drawing = roadsOnly && draw.on;

  const start = async () => {
    if (!files.boundary && !files.network.length) return;
    setBusy(true);
    setError(null);
    let jobId: string | null = null;
    try {
      const created = await api.post<{ job: ImportJob }>('/api/network/imports', { projectId, label: label.trim() || undefined });
      jobId = created.job._id;
      if (drawing) {
        await api.patch(`/api/network/imports/${jobId}`, {
          drawZones: { minKm: Number(draw.minKm), maxKm: Number(draw.maxKm), absorbRemainder: draw.absorbRemainder },
        });
      }
      // Several road zips go up as one zip of zips; the server opens the ones inside.
      const roads = files.network.length > 1
        ? await zipFiles(files.network, `${(label.trim() || 'roads').replace(/[^\w .-]+/g, '_')} roads.zip`)
        : files.network[0] || null;
      const upload: Record<Layer, File | null> = { boundary: files.boundary, network: roads };
      for (const layer of ['boundary', 'network'] as const) {
        const file = upload[layer];
        if (!file) continue;
        setProgress({ layer, percent: 0 });
        // eslint-disable-next-line no-await-in-loop
        await uploadRaw(`/api/network/imports/${jobId}/file?layer=${layer}&hold=1`, file, (percent) =>
          setProgress({ layer, percent })
        );
      }
      setProgress(null);
      // Both are in: now, and only now, the import starts.
      await api.post(`/api/network/imports/${jobId}/validate`, {});
      onStarted(jobId);
    } catch (e) {
      setProgress(null);
      setBusy(false);
      setError(
        `${e instanceof Error ? e.message : 'The upload failed'}${
          jobId ? ' — the import is saved as a draft; open it to retry.' : ''
        }`
      );
      if (jobId) onStarted(jobId);
    }
  };

  const sizeOk = Number(draw.minKm) >= 5 && Number(draw.maxKm) >= 5;

  return (
    <Modal title="New import" onClose={busy ? () => {} : onClose}>
      <p className="cov-sub" style={{ marginTop: 0 }}>
        Pick the customer’s work areas and road network together and they are loaded as one
        delivery. You can select all the files at once — the roads may be several .zip files, one
        per road class. No work areas? The zones can be drawn from the roads.
      </p>

      <div className="field">
        <label htmlFor="import-label">Name</label>
        <input
          id="import-label"
          className="input"
          value={label}
          maxLength={120}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Christchurch"
        />
      </div>

      <input
        ref={bothRef}
        type="file"
        multiple
        accept=".zip,application/zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          place([...(e.target.files || [])]);
          e.target.value = '';
        }}
      />
      <div
        className={`newimp-drop${over === 'both' ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => !busy && bothRef.current?.click()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); bothRef.current?.click(); } }}
        {...dropTarget((f) => dropped(f, place), (o) => setOver(o ? 'both' : null), busy)}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d="M12 16V4M7 9l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" />
        </svg>
        <b>Drop the .zip files here</b>
        <span>or click to choose — they go to the right slot by name</span>
      </div>

      <div className="newimp-slots">
        {(['boundary', 'network'] as const).map((layer) => {
          const chosen = layer === 'boundary' ? (files.boundary ? [files.boundary] : []) : files.network;
          const active = progress?.layer === layer;
          return (
            <div
              key={layer}
              className={`cov-file${chosen.length ? ' has' : ''}${over === layer ? ' over' : ''}`}
              {...dropTarget(
                (f) => dropped(f, (zips) => setFiles((cur) => (layer === 'boundary'
                  ? { ...cur, boundary: zips[0] }
                  : { ...cur, network: [...cur.network, ...zips.filter((z) => !cur.network.some((n) => n.name === z.name && n.size === z.size))] }))),
                (o) => setOver(o ? layer : null),
                busy
              )}
            >
              <div className="cov-file-label">
                {LAYER_LABEL[layer]}
                {layer === 'network' && <span className="newimp-opt"> · optional</span>}
              </div>
              {chosen.length ? (
                <div className="cov-file-have">
                  {chosen.map((file) => (
                    <div key={file.name} style={{ display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{file.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {mb(file.size)}
                        {layer === 'network' && chosen.length > 1 && !busy && (
                          <button
                            type="button"
                            className="cov-link"
                            style={{ marginLeft: 8 }}
                            onClick={() => setFiles((cur) => ({ ...cur, network: cur.network.filter((n) => n !== file) }))}
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: 'var(--muted)', fontSize: 13, padding: '4px 0 8px' }}>Not chosen</div>
              )}
              {active && (
                <div className="cov-bar" style={{ margin: '6px 0 8px' }}>
                  <div className="cov-bar-fill brand" style={{ width: `${progress!.percent}%` }} />
                </div>
              )}
              <input
                ref={(el) => { oneRef.current[layer] = el; }}
                type="file"
                multiple={layer === 'network'}
                accept=".zip,application/zip"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const picked = [...(e.target.files || [])];
                  if (picked.length) {
                    setFiles((cur) => (layer === 'boundary'
                      ? { ...cur, boundary: picked[0] }
                      : { ...cur, network: [...cur.network, ...picked.filter((z) => !cur.network.some((n) => n.name === z.name && n.size === z.size))] }));
                  }
                  e.target.value = '';
                }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => oneRef.current[layer]?.click()}>
                  {active
                    ? `Uploading ${progress!.percent}%`
                    : layer === 'network' && chosen.length ? 'Add .zip' : chosen.length ? 'Change' : 'Choose .zip'}
                </button>
                {chosen.length > 0 && !busy && (
                  <button
                    type="button"
                    className="cov-link"
                    onClick={() => setFiles((cur) => (layer === 'boundary' ? { ...cur, boundary: null } : { ...cur, network: [] }))}
                  >
                    {layer === 'network' && chosen.length > 1 ? 'Remove all' : 'Remove'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {files.boundary && files.network.length === 1 && !busy && (
        <button type="button" className="cov-link" style={{ marginTop: 8 }} onClick={swap}>
          ⇄ Swap — the files are the other way round
        </button>
      )}

      {roadsOnly && (
        <div className="newimp-draw">
          <label className="cov-toggle" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={draw.on}
              disabled={busy}
              onChange={(e) => setDraw((d) => ({ ...d, on: e.target.checked }))}
            />
            <span>
              <b>No work areas? Draw zones from the roads.</b> An outline is drawn round the roads
              and cut into zones of about this much road each — the same as “Split into zones” on
              the map, so the size can be changed there later.
            </span>
          </label>
          {draw.on ? (
            <div className="newimp-draw-size">
              <span>Each zone</span>
              <input
                className="input"
                type="number"
                min={5}
                value={draw.minKm}
                disabled={busy}
                aria-label="Smallest zone, km"
                onChange={(e) => setDraw((d) => ({ ...d, minKm: e.target.value }))}
              />
              <span>to</span>
              <input
                className="input"
                type="number"
                min={5}
                value={draw.maxKm}
                disabled={busy}
                aria-label="Largest zone, km"
                onChange={(e) => setDraw((d) => ({ ...d, maxKm: e.target.value }))}
              />
              <span>km of road</span>
              <label className="newimp-draw-left">
                <input
                  type="checkbox"
                  checked={draw.absorbRemainder}
                  disabled={busy}
                  onChange={(e) => setDraw((d) => ({ ...d, absorbRemainder: e.target.checked }))}
                />
                Share the leftover out (zones may run a little over)
              </label>
            </div>
          ) : (
            <div className="cov-issue warn" style={{ marginTop: 8 }}>
              Roads only: they will be added to the project’s current work areas. To load a new
              place, choose its work areas too — or tick the box above.
            </div>
          )}
        </div>
      )}
      {!files.network.length && files.boundary && (
        <div className="cov-sub" style={{ marginTop: 10 }}>
          Without the road network the areas load, but nothing can be measured as driven until roads are added.
        </div>
      )}

      {error && <div className="cov-issue error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        <button className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button
          className="btn"
          disabled={busy || (!files.boundary && !files.network.length) || (drawing && !sizeOk)}
          title={drawing && !sizeOk ? 'Enter the zone size in km — 5 or more' : undefined}
          onClick={start}
        >
          {busy ? (progress ? 'Uploading…' : 'Starting…') : 'Upload and import'}
        </button>
      </div>
    </Modal>
  );
}
