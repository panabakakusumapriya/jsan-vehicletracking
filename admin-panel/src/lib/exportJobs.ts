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

/** Human-readable one-liner for a job in flight. */
export function describeJob(job: ExportJobStatus): string {
  if (job.status === 'queued') return 'Queued…';
  if (job.status === 'running') {
    return job.total ? `Preparing ${job.done}/${job.total} trips…` : 'Preparing…';
  }
  if (job.status === 'failed') return job.error || 'Export failed';
  return 'Ready';
}

/**
 * Queue an export, wait for it, download it.
 *
 * Polling starts fast and eases off: a 20-trip export is done almost immediately and should not
 * feel sluggish, while a 500-trip one should not generate hundreds of needless requests.
 */
export async function runExportJob(
  params: ExportJobRequest,
  onProgress?: (job: ExportJobStatus) => void
): Promise<void> {
  const { jobId } = await api.post<{ jobId: string }>('/api/trips/export-jobs', params);

  let delay = 500;
  const deadline = Date.now() + 30 * 60 * 1000; // a stuck job must not poll forever

  for (;;) {
    const job = await api.get<ExportJobStatus>(`/api/trips/export-jobs/${jobId}`);
    onProgress?.(job);

    if (job.status === 'ready') {
      await downloadFile(`/api/trips/export-jobs/${jobId}/download`, job.fileName || 'trips.zip');
      return;
    }
    if (job.status === 'failed') throw new Error(job.error || 'Export failed');
    if (Date.now() > deadline) throw new Error('Export timed out — please try a smaller date range');

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 4000);
  }
}
