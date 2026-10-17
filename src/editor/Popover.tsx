import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A key that opens a panel under it: where rarer settings live so the toolbar
 * stays one row. The panel is always in the DOM (only hidden), so its controls
 * keep their state and scripts can reach them. Closes on outside click and Escape.
 */
export function Popover({
  label,
  title,
  className = '',
  align = 'left',
  children,
}: {
  label: ReactNode;
  title: string;
  className?: string;
  align?: 'left' | 'right';
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className={`popover ${className}`} ref={root}>
      <button className={`opener${open ? ' active' : ''}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)} title={title}>
        {label}
        <svg className="caret" width="8" height="5" viewBox="0 0 8 5" aria-hidden="true">
          <path d="M0 0h8L4 5z" />
        </svg>
      </button>
      <div className={`popover-panel ${align}`} hidden={!open} role="group" aria-label={title}>
        {typeof children === 'function' ? children(close) : children}
      </div>
    </div>
  );
}
