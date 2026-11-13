import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ExplorerDrawerProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Right-side drawer (>= sm) / bottom sheet (< sm). Same look as ExplorerPanel, mirrored to the right.
 * Rendered only while open. Not modal (the globe stays usable); it is an overlay, so opening it never resizes
 * or moves the map. Focus moves into it on open; Escape closes it from anywhere inside.
 * No transitions: nothing here animates, so prefers-reduced-motion is respected by construction.
 */
export const ExplorerDrawer: React.FC<ExplorerDrawerProps> = ({ title, onClose, children }) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      className="glass-panel absolute z-[36] flex flex-col min-w-0 outline-none bg-surface/75 hover:bg-surface/85 backdrop-blur-xl border border-line-strong/60 shadow-elev-3 transition-colors
        inset-x-0 bottom-[var(--attr-h)] max-h-[72%] rounded-t-card
        sm:inset-x-auto sm:right-3 sm:left-auto sm:top-3 sm:bottom-[var(--above-toolbar)] sm:w-[26rem] sm:max-w-[calc(100%-1.5rem)] sm:max-h-none sm:rounded-card"
    >
      <div className="flex items-center justify-between gap-2 pl-4 pr-1.5 border-b border-line shrink-0">
        <h2 className="text-sm font-bold text-fg">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title.toLowerCase()}`}
          className="min-h-touch min-w-touch inline-flex items-center justify-center rounded-control text-fg-muted hover:text-fg hover:bg-raised"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain">{children}</div>
    </aside>
  );
};
