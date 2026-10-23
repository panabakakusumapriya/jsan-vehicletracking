import { AppIcon } from './AppIcon';
import { useEffect, useRef, useState } from 'react';

type ExportFormat = 'kml' | 'json';
export type ExportLayer = 'raw' | 'snapped';
export type SheetFormat = 'xlsx' | 'csv';
export type SheetLevel = 'days' | 'trips';

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
  /**
   * The table as a spreadsheet (Excel: days + trips sheets; CSV: one of them). Shown above the
   * route files when given — most people exporting from a table want the table.
   */
  onSpreadsheet?: (format: SheetFormat, level: SheetLevel) => Promise<void>;
}

type SheetChoice = { format: SheetFormat; level: SheetLevel; label: string; hint: string };
const SHEET_CHOICES: SheetChoice[] = [
  { format: 'xlsx', level: 'days', label: 'Excel (.xlsx)', hint: 'Days and trips sheets, as listed here' },
  { format: 'csv', level: 'days', label: 'CSV · one row per day', hint: 'Each driver’s day: km, UKM, hours, markers' },
  { format: 'csv', level: 'trips', label: 'CSV · one row per trip', hint: 'Every trip with its times, km and UKM' },
];

type Choice = { format: ExportFormat; layer: ExportLayer; label: string; hint: string; needsSnapped?: boolean };

const CHOICES: Choice[] = [
  { format: 'kml', layer: 'raw', label: 'Raw GPS · KML', hint: 'The recorded trace, exactly as logged' },
  { format: 'kml', layer: 'snapped', label: 'Snapped to road · KML', hint: 'Matched route + UKM layer, styled', needsSnapped: true },
  { format: 'json', layer: 'raw', label: 'Raw GPS · JSON', hint: 'Points with speed, heading, timestamps' },
];



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

export function ExportButtons({ onExport, disabled, snappedAvailable = false, status, onSpreadsheet }: ExportButtonsProps) {
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

  const run = async (label: string, job: () => Promise<void>) => {
    setOpen(false);
    setPending(label);
    setError(null);
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setPending(null);
    }
  };
  const handlePick = (choice: Choice) => run(choice.label, () => onExport(choice.format, choice.layer));
  const sectionTitle: React.CSSProperties = {
    padding: '6px 10px 2px', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--muted)',
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        className="btn-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || pending !== null}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}
      >
        <AppIcon name="download" size={16} />
        {pending ? (status || 'Exporting…') : 'Export'}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          className="export-menu"
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
          {onSpreadsheet && (
            <>
              <div style={sectionTitle}>Spreadsheet</div>
              {SHEET_CHOICES.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  role="menuitem"
                  title={c.hint}
                  onClick={() => run(c.label, () => onSpreadsheet(c.format, c.level))}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontWeight: 600, color: 'var(--text-2)', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  {c.label}
                  <span style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginTop: 1 }}>{c.hint}</span>
                </button>
              ))}
              <div style={{ height: 1, background: 'var(--line)', margin: '4px 6px' }} />
              <div style={sectionTitle}>Routes</div>
            </>
          )}
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
