import React, { useId } from 'react';
import { SlidersHorizontal, RotateCcw, ChevronDown, AlertTriangle } from 'lucide-react';
import { FilterState } from '../../types/fire';
import { datePresets, defaultFilters, filterConflicts } from '../../utils/filterValidation';

interface FilterBarProps {
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  totalMatches: number;
  /** Single-column layout for narrow containers (the Explorer side panel). */
  compact?: boolean;
}

const labelClass = 'block text-fg-muted font-medium mb-1.5 text-2xs';
const fieldClass =
  'w-full min-h-touch bg-raised border border-line-strong rounded-control px-3 text-xs text-fg focus-visible:outline-accent transition-colors';

export const FilterBar: React.FC<FilterBarProps> = ({ filters, setFilters, totalMatches, compact = false }) => {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const conflicts = filterConflicts(filters);
  const presets = datePresets();

  const resetFilters = () => setFilters(defaultFilters());

  return (
    <div className="bg-surface border border-line rounded-card p-4 text-xs text-fg shadow-elev-1 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <SlidersHorizontal className="h-4 w-4 text-accent" aria-hidden="true" />
          <span className="font-semibold text-fg text-sm">Date &amp; sensor filters</span>
          <span className="numeric text-fg-muted font-medium">{totalMatches} matching observations</span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Date presets">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setFilters((prev) => ({ ...prev, startDate: p.start, endDate: p.end }))}
              className="min-h-touch px-3 rounded-control bg-raised hover:bg-overlay text-fg-muted hover:text-fg transition-colors"
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={resetFilters}
            className="min-h-touch inline-flex items-center gap-1.5 px-3 rounded-control bg-raised hover:bg-overlay text-fg-muted hover:text-danger border border-line transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {conflicts.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-control border border-danger/60 p-3 text-danger">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <div>
            {conflicts.map((c) => (
              <p key={c}>{c} No observations can match this combination.</p>
            ))}
          </div>
        </div>
      )}

      <div className={`grid gap-3.5 ${compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-5'}`}>
        <div>
          <label htmlFor={id('start')} className={labelClass}>Start date (UTC)</label>
          <input
            id={id('start')}
            type="date"
            value={filters.startDate}
            max={filters.endDate || undefined}
            onChange={(e) => setFilters((prev) => ({ ...prev, startDate: e.target.value }))}
            className={`${fieldClass} numeric`}
          />
        </div>

        <div>
          <label htmlFor={id('end')} className={labelClass}>End date (UTC)</label>
          <input
            id={id('end')}
            type="date"
            value={filters.endDate}
            min={filters.startDate || undefined}
            onChange={(e) => setFilters((prev) => ({ ...prev, endDate: e.target.value }))}
            className={`${fieldClass} numeric`}
          />
        </div>

        <div>
          <label htmlFor={id('sensor')} className={labelClass}>Sensor</label>
          <div className="relative">
            <select
              id={id('sensor')}
              value={filters.sensorMode === 'HARMONIZED' ? 'ALL' : filters.sensorMode}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, sensorMode: e.target.value as FilterState['sensorMode'] }))
              }
              className={`${fieldClass} pr-8 appearance-none cursor-pointer`}
            >
              <option value="ALL">Both sensors (shown separately)</option>
              <option value="MODIS_ONLY">MODIS only (1 km)</option>
              <option value="VIIRS_ONLY">VIIRS only (375 m)</option>
            </select>
            <ChevronDown className="h-4 w-4 text-fg-muted absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          </div>
        </div>

        <div>
          <label htmlFor={id('sat')} className={labelClass}>Satellite</label>
          <div className="relative">
            <select
              id={id('sat')}
              value={filters.satellite}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, satellite: e.target.value as FilterState['satellite'] }))
              }
              className={`${fieldClass} pr-8 appearance-none cursor-pointer`}
            >
              <option value="ALL">All satellites</option>
              <option value="Terra">Terra (MODIS, morning)</option>
              <option value="Aqua">Aqua (MODIS, afternoon)</option>
              <option value="Suomi-NPP">Suomi-NPP (VIIRS 375 m)</option>
              <option value="NOAA-20">NOAA-20 (VIIRS 375 m)</option>
            </select>
            <ChevronDown className="h-4 w-4 text-fg-muted absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center text-2xs text-fg-muted font-medium mb-1.5">
            <label htmlFor={id('frp')}>Minimum FRP</label>
            <span className="text-accent numeric font-semibold">{filters.minFRP} MW</span>
          </div>
          <input
            id={id('frp')}
            type="range"
            min="0"
            max="100"
            step="5"
            value={filters.minFRP}
            onChange={(e) => setFilters((prev) => ({ ...prev, minFRP: Number(e.target.value) }))}
            className="w-full min-h-touch accent-amber-400 cursor-pointer"
          />
        </div>
      </div>
    </div>
  );
};
