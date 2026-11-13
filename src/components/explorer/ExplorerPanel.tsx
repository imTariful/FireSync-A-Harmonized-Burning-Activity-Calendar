import React from 'react';
import { X } from 'lucide-react';

interface ExplorerPanelProps {
  title?: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Collapsible side panel (>= sm) / bottom sheet (< sm) for explorer controls.
 * Always mounted: closing only hides it, so the controls FireGlobe portals into it keep their state.
 * Not modal (the globe stays usable); Escape closes it from anywhere inside.
 */
export const ExplorerPanel = React.forwardRef<HTMLElement, ExplorerPanelProps>(
  ({ title = 'Explore', open, onClose, children }, ref) => {
    // Closed = invisible AND inert, so hidden controls are never reachable with Tab.
    return (
      <aside
        ref={ref}
        aria-label={title}
        inert={!open}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        className={`glass-panel absolute z-[35] flex flex-col bg-surface/75 hover:bg-surface/85 backdrop-blur-xl border border-line-strong/60 shadow-elev-3 transition-colors
          inset-x-0 bottom-[var(--attr-h)] max-h-[72%] rounded-t-card
          sm:inset-x-auto sm:left-3 sm:top-3 sm:bottom-[var(--above-toolbar)] sm:w-80 sm:max-h-none sm:rounded-card
          ${open ? '' : 'invisible pointer-events-none'}`}
      >
        <div className="flex items-center justify-between gap-2 pl-4 pr-1.5 border-b border-line shrink-0">
          <h2 className="text-sm font-bold text-fg">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title.toLowerCase()}`}
            className="min-h-touch min-w-touch inline-flex items-center justify-center rounded-control text-fg-muted hover:text-fg hover:bg-raised cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{children}</div>
      </aside>
    );
  }
);
ExplorerPanel.displayName = 'ExplorerPanel';
