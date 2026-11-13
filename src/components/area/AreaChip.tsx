import React from 'react';
import { MapPinned } from 'lucide-react';
import type { Area } from '../../utils/area';
import { NO_ARCHIVE_FOR_AREA_MESSAGE } from '../../utils/area';

interface AreaChipProps {
  area: Area;
  /** Switches to the Explorer with the Area section open. */
  onChange: () => void;
}

/** "Area: {name} · Change on map": shown at the top of every page that follows the Explorer's area. */
export const AreaChip: React.FC<AreaChipProps> = ({ area, onChange }) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
    <button
      type="button"
      onClick={onChange}
      aria-label={`Area: ${area.name}. Change on map`}
      className="min-h-touch inline-flex items-center gap-2 max-w-full px-3 rounded-full bg-surface border border-line-strong text-fg hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent transition-colors"
    >
      <MapPinned className="h-4 w-4 text-accent shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        <span className="text-fg-muted">Area:</span> <span className="font-semibold">{area.name}</span>
      </span>
      <span className="text-fg-muted shrink-0" aria-hidden="true">
        ·
      </span>
      <span className="text-accent font-medium shrink-0">Change on map</span>
    </button>
  </div>
);

/** Shown instead of the page body when the loaded data has no rows for the chosen area (never zeros that look like "no fires"). */
export const AreaEmptyState: React.FC<{ onChange?: () => void }> = ({ onChange }) => (
  <div role="status" className="rounded-card border border-line-strong bg-surface p-6 text-sm text-fg space-y-3">
    <p>{NO_ARCHIVE_FOR_AREA_MESSAGE}</p>
    <p className="text-xs text-fg-muted">
      This is missing data, not proof of no fire. The live map can still show current detections for this area when
      live data is available.
    </p>
    {onChange && (
      <button
        type="button"
        onClick={onChange}
        className="min-h-touch px-4 rounded-control bg-accent hover:bg-accent-hover text-accent-fg font-semibold text-xs transition-colors"
      >
        Choose another area on the map
      </button>
    )}
  </div>
);
