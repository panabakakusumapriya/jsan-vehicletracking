import { api, downloadFile } from './api';

/**
 * Client side of the background bulk export (backend: services/exportRunner.js).
 *
 * Bulk exports used to stream a zip inside the request, which meant the browser held an open
 * connection for the whole build and a proxy timeout produced a truncated file that still looked
 * like a successful download. Now the request only queues a job; this polls it and downloads the
 * artifact once the server says it is complete on disk.
 */

export interface ExportJobStatus {
  jobId: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  total: number;
  done: number;
  fellBackToRaw: number;
  bytes: number;
  fileName: string | null;
  error: string | null;
}

export interface ExportJobRequest {
  format: 'kml' | 'json';
  layer: 'raw' | 'snapped';
  [key: string]: string | undefined;
}

/**
 * Where a long export is up to, for a progress panel with time left.
 *
 *   queued       waiting for the server to start it (one export runs at a time)
 *   building     the server is writing the files: `done` of `total` trips
 *   packing      every trip written; the server is zipping and storing the file
 *   downloading  the file is coming down: `received` of `bytes`
 *
 * `finishBy` is when this phase should end (epoch ms), from the speed actually measured so far;
 * null until there is enough to go on. A screen counts down to it between updates.
 */
export interface ExportProgress {
  phase: 'queued' | 'building' | 'packing' | 'downloading';
  done: number;
  total: number;
  received: number;
  bytes: number;
  /** Download speed, bytes per second; 0 until measured. */
  bytesPerSec: number;
  finishBy: number | null;
  startedAt: number;
  /** In the queue behind another export for more than a few seconds. */
  waiting: boolean;
}

/** Human-readable one-liner for a job in flight. */
export function describeJob(job: ExportJobStatus): string {
  if (job.status === 'queued') return 'Queued…';
  if (job.status === 'running') {
    return job.total ? `Preparing ${job.done}/${job.total} trips…` : 'Preparing…';
  }
  if (job.status === 'failed') return job.error || 'Export failed';
  return 'Ready';
}

/** "about 2 min left", "less than 10 s left" — for a countdown to `finishBy`. */
export function timeLeftText(finishBy: number | null, now = Date.now()): string | null {
  if (finishBy == null) return null;
  const s = Math.max(0, Math.round((finishBy - now) / 1000));
  if (s < 10) return 'a few seconds left';
  if (s < 60) return `about ${Math.ceil(s / 5) * 5} s left`;
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min left`;
  const h = Math.floor(m / 60);
  return `about ${h} h ${m % 60} min left`;
}

/** "1:05" / "12:40" / "1:02:03" — how long it has been running. */
export function clockText(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Rate over the last `windowMs` of samples, per second, or 0 when there is not enough to go on.
 * A sliding window rather than the average since the start, so a slow first minute (the server
 * busy with something else) does not keep the estimate pessimistic once it speeds up.
 */
function rateOf(samples: { t: number; v: number }[], windowMs: number, minSpanMs: number): number {
  const now = samples.length ? samples[samples.length - 1].t : 0;
  const recent = samples.filter((x) => now - x.t <= windowMs);
  if (recent.length < 2) return 0;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const span = b.t - a.t;
  if (span < minSpanMs || b.v <= a.v) return 0;
  return ((b.v - a.v) / span) * 1000;
}

/**
 * Queue an export, wait for it, download it.
 *
 * Polling starts fast and eases off: a 20-trip export is done almost immediately and should not
 * feel sluggish, while a 500-trip one should not generate hundreds of needless requests.
 *
 * @param onDetail  phase, counts and an estimated finish time — for a progress panel
 * @param opts.timeoutMs  give up after this long (default 30 min)
 */
export async function runExportJob(
  params: ExportJobRequest,
  onProgress?: (job: ExportJobStatus) => void,
  onDetail?: (p: ExportProgress) => void,
  opts: { timeoutMs?: number } = {}
): Promise<ExportJobStatus> {
  const startedAt = Date.now();
  const { jobId } = await api.post<{ jobId: string }>('/api/trips/export-jobs', params);

  let delay = 500;
  const deadline = startedAt + (opts.timeoutMs ?? 30 * 60 * 1000); // a stuck job must not poll forever
  const built: { t: number; v: number }[] = [];
  let queuedSince: number | null = null;

  for (;;) {
    const job = await api.get<ExportJobStatus>(`/api/trips/export-jobs/${jobId}`);
    onProgress?.(job);
    const now = Date.now();

    if (job.status === 'ready') {
      const bytes = job.bytes || 0;
      const got: { t: number; v: number }[] = [];
      let lastReport = 0;
      await downloadFile(`/api/trips/export-jobs/${jobId}/download`, job.fileName || 'trips.zip', (received, total) => {
        const t = Date.now();
        got.push({ t, v: received });
        if (got.length > 400) got.splice(0, got.length - 400);
        // A few updates a second is plenty for a progress bar.
        if (t - lastReport < 250 && received < (total || bytes)) return;
        lastReport = t;
        const size = total && total >= received ? total : bytes >= received ? bytes : 0;
        const speed = rateOf(got, 4000, 800);
        onDetail?.({
          phase: 'downloading', done: job.done, total: job.total, received, bytes: size, bytesPerSec: speed,
          finishBy: size && speed ? t + ((size - received) / speed) * 1000 : null,
          startedAt, waiting: false,
        });
      });
      return job;
    }
    if (job.status === 'failed') throw new Error(job.error || 'Export failed');
    if (now > deadline) throw new Error('Export timed out — please try a smaller date range');

    if (job.status === 'queued') {
      if (queuedSince == null) queuedSince = now;
      onDetail?.({
        phase: 'queued', done: 0, total: job.total, received: 0, bytes: 0, bytesPerSec: 0,
        finishBy: null, startedAt, waiting: now - queuedSince > 6000,
      });
    } else {
      built.push({ t: now, v: job.done });
      const packing = job.total > 0 && job.done >= job.total;
      const rate = rateOf(built, 45_000, 3000);
      onDetail?.({
        phase: packing ? 'packing' : 'building', done: job.done, total: job.total, received: 0, bytes: 0, bytesPerSec: 0,
        finishBy: !packing && rate > 0 ? now + ((job.total - job.done) / rate) * 1000 : null,
        startedAt, waiting: false,
      });
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 4000);
  }
}
