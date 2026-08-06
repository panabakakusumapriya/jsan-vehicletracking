import { useEffect, useRef, useState } from 'react';

/**
 * Native <input type="date"> always displays in whatever format the browser/OS locale
 * dictates (mm/dd/yyyy, dd/mm/yyyy, etc.) — the `lang` attribute does NOT override this in
 * Chromium, so it can't be forced via markup alone. This wraps a hidden native date input
 * (kept only for its calendar-picker UI, opened via showPicker()) with a manually-masked
 * DD/MM/YYYY text field that's what the user actually sees and types into. The value/onChange
 * contract is still plain ISO (yyyy-mm-dd) so callers don't need to change anything else.
 */

const isoToDisplay = (iso: string) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

const displayToIso = (display: string): string | null => {
  const match = display.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) {
    return null;
  }
  return `${y}-${m}-${d}`;
};

export function DateField({
  value,
  onChange,
  min,
  max,
  style,
}: {
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  style?: React.CSSProperties;
}) {
  const nativeRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(isoToDisplay(value));

  useEffect(() => {
    setText(isoToDisplay(value));
  }, [value]);

  const handleTextChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 8);
    let formatted = digits;
    if (digits.length > 4) formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    else if (digits.length > 2) formatted = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    setText(formatted);

    if (formatted === '') {
      onChange('');
      return;
    }
    const iso = displayToIso(formatted);
    if (iso) onChange(iso);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', ...style }}>
      <input
        className="input"
        type="text"
        inputMode="numeric"
        placeholder="DD/MM/YYYY"
        maxLength={10}
        value={text}
        onChange={e => handleTextChange(e.target.value)}
        style={{ width: '100%', margin: 0, paddingRight: 30 }}
      />
      <button
        type="button"
        aria-label="Open calendar"
        onClick={() => {
          try {
            (nativeRef.current as any)?.showPicker?.();
          } catch {
            /* showPicker unsupported — text entry above still works */
          }
        }}
        style={{
          position: 'absolute', right: 6, background: 'transparent', border: 'none',
          cursor: 'pointer', padding: 2, display: 'flex', color: 'var(--muted)', fontSize: 14,
        }}
      >
        📅
      </button>
      <input
        ref={nativeRef}
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={e => onChange(e.target.value)}
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, border: 'none', padding: 0 }}
        tabIndex={-1}
      />
    </div>
  );
}
