import { useEffect, useRef, useState } from 'react';

type ExportFormat = 'kml' | 'json';
export type ExportLayer = 'raw' | 'snapped';

interface ExportButtonsProps {
  onExport: (format: ExportFormat, layer: ExportLayer) => Promise<void>;
  disabled?: boolean;
  /**
   * Whether a snapped route exists for this trip. The snapped choices are shown but disabled when
   * it doesn't, rather than hidden — a menu that changes shape between trips leaves people
   * wondering whether they misremembered, and "not map-matched yet" is the more useful answer.
   */
  snappedAvailable?: boolean;
  /**
   * Live progress for a background export (e.g. "Preparing 120/540 trips…"). Bulk exports are
   * queued server-side and can run for minutes, so a static "Exporting…" would leave the user
   * unable to tell a working export from a stuck one.
   */
  status?: string | null;
}

type Choice = { format: ExportFormat; layer: ExportLayer; label: string; hint: string; needsSnapped?: boolean };

const CHOICES: Choice[] = [
  { format: 'kml', layer: 'raw', label: 'Raw GPS · KML', hint: 'The recorded trace, exactly as logged' },
  { format: 'kml', layer: 'snapped', label: 'Snapped to road · KML', hint: 'Matched route + UKM layer, styled', needsSnapped: true },
  { format: 'json', layer: 'raw', label: 'Raw GPS · JSON', hint: 'Points with speed, heading, timestamps' },
];

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export function ExportButtons({ onExport, disabled, snappedAvailable = false, status }: ExportButtonsProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handlePick = async (choice: Choice) => {
    setOpen(false);
    setPending(choice.label);
    setError(null);
    try {
      await onExport(choice.format, choice.layer);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setPending(null);
    }
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        className="btn-ghost"
        disabled={disabled || pending !== null}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}
      >
        <DownloadIcon />
        {pending ? (status || 'Exporting…') : 'Export'}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 20,
            minWidth: 232,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-md)',
            padding: 4,
          }}
        >
          {CHOICES.map((choice) => {
            const unavailable = !!choice.needsSnapped && !snappedAvailable;
            return (
              <button
                key={choice.label}
                type="button"
                role="menuitem"
                disabled={unavailable}
                title={unavailable ? 'This trip has not been map-matched yet' : choice.hint}
                onClick={() => handlePick(choice)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 13,
                  fontWeight: 600,
                  color: unavailable ? 'var(--muted)' : 'var(--text-2)',
                  cursor: unavailable ? 'not-allowed' : 'pointer',
                  opacity: unavailable ? 0.55 : 1,
                }}
                onMouseEnter={(e) => { if (!unavailable) e.currentTarget.style.background = 'var(--bg)'; }}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                {choice.label}
                <span style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginTop: 1 }}>
                  {unavailable ? 'Not map-matched yet' : choice.hint}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
    </div>
  );
}
