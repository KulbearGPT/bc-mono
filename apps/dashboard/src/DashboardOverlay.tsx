import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function DashboardOverlay(props: { label: string; onClose?: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose?.();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [props.onClose]);

  const overlay = <div className="dashboard-overlay" onMouseDown={(event) => {
    if (event.target === event.currentTarget) props.onClose?.();
  }}>
    <div ref={dialogRef} className="dashboard-overlay__dialog" role="dialog" aria-modal="true" aria-label={props.label} tabIndex={-1}>
      {props.children}
    </div>
  </div>;
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}

