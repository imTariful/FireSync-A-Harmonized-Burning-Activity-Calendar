import React from 'react';
import { ChevronLeft, ChevronRight, Info, X } from 'lucide-react';
import { BASEMAP_OPTIONS, BasemapId, hasImageryDate, imageryDateNote } from './basemap';

interface BasemapSwitcherProps {
  value: BasemapId;
  onChange: (id: BasemapId) => void;
  /** Satellite imagery day (YYYY-MM-DD, UTC). The date row shows only for Satellite and only when given. */
  imageryDate?: string;
  /** Step the imagery day by one (-1 earlier, +1 later). Never called automatically. */
  onDateStep?: (delta: -1 | 1) => void;
  canStepBack?: boolean;
  canStepForward?: boolean;
}

/** Three-way basemap chooser for the Layers section. */
export const BasemapSwitcher: React.FC<BasemapSwitcherProps> = ({
  value,
  onChange,
  imageryDate,
  onDateStep,
  canStepBack = true,
  canStepForward = true,
}) => (
  <div className="pb-2 mb-1 border-b border-line">
    <div id="basemap-label" className="text-2xs uppercase tracking-wide text-fg-subtle mb-1">
      Basemap
    </div>
    <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-labelledby="basemap-label">
      {BASEMAP_OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={`min-h-touch rounded-control text-xs font-medium transition-colors ${
            value === o.id ? 'bg-accent text-accent-fg' : 'bg-raised text-fg hover:bg-overlay'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
    {hasImageryDate(value) && imageryDate && onDateStep && (
      <div className="mt-1">
        <div className="flex items-center justify-between gap-1" role="group" aria-label="Satellite imagery date (UTC)">
          <button
            type="button"
            onClick={() => onDateStep(-1)}
            disabled={!canStepBack}
            aria-label="Previous day"
            className="min-h-touch min-w-touch inline-flex items-center justify-center rounded-control bg-raised text-fg hover:bg-overlay disabled:opacity-40 disabled:hover:bg-raised disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <time dateTime={imageryDate} className="text-xs font-medium tabular-nums text-fg" aria-live="polite">
            {imageryDate}
          </time>
          <button
            type="button"
            onClick={() => onDateStep(1)}
            disabled={!canStepForward}
            aria-label="Next day"
            className="min-h-touch min-w-touch inline-flex items-center justify-center rounded-control bg-raised text-fg hover:bg-overlay disabled:opacity-40 disabled:hover:bg-raised disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-1 text-2xs text-fg-subtle">{imageryDateNote(imageryDate)}</p>
      </div>
    )}
  </div>
);

/** Small, non-blocking notice shown over the globe when GIBS tiles failed. */
export const BasemapNotice: React.FC<{ message: string; onDismiss: () => void }> = ({ message, onDismiss }) => (
  <div
    role="status"
    className="pointer-events-auto bg-surface/95 border border-line-strong text-fg text-xs rounded-card pl-3 pr-1 py-1 flex items-center gap-2 shadow-elev-3"
  >
    <Info className="h-3.5 w-3.5 text-accent shrink-0" aria-hidden="true" />
    <span className="min-w-0">{message}</span>
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss notice"
      className="shrink-0 min-h-touch min-w-touch inline-flex items-center justify-center rounded-full hover:bg-raised text-fg-muted hover:text-fg transition-colors"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  </div>
);
