import { useEffect, useRef, useState } from 'react';

type ExportFormat = 'kml' | 'json';

interface ExportButtonsProps {
  onExport: (format: ExportFormat) => Promise<void>;
  disabled?: boolean;
}

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'kml', label: 'KML' },
  { value: 'json', label: 'JSON' },
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

export function ExportButtons({ onExport, disabled }: ExportButtonsProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ExportFormat | null>(null);
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

  const handlePick = async (format: ExportFormat) => {
    setOpen(false);
    setPending(format);
    setError(null);
    try {
      await onExport(format);
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
        {pending ? `Exporting ${pending.toUpperCase()}…` : 'Export'}
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
            minWidth: 130,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-md)',
            padding: 4,
          }}
        >
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="menuitem"
              onClick={() => handlePick(f.value)}
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
                color: 'var(--text-2)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
    </div>
  );
}
