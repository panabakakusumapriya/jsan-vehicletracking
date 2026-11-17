import { AppIcon } from './AppIcon';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Modal({ title, onClose, children, wide = false }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Roughly square, two-column layout for forms with many fields. */
  wide?: boolean;
}) {
  // In fullscreen the browser shows ONLY the fullscreen element, so a dialog rendered anywhere
  // else opens invisibly behind it (the coverage map's Assign / Split / Clear dialogs did exactly
  // that). Opened while something is fullscreen, the dialog goes inside it. Picked once, at open:
  // switching parents later would remount the dialog and lose what was typed into it — and it
  // still shows if fullscreen is left, since it is position: fixed.
  const [host] = useState<Element | null>(() =>
    typeof document !== 'undefined' ? document.fullscreenElement : null
  );

  const dialog = (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close"><AppIcon name="close" size={19} /></button>
        </div>
        {children}
      </div>
    </div>
  );
  return host ? createPortal(dialog, host) : dialog;
}
