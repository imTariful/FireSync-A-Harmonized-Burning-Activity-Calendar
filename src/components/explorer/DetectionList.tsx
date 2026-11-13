import { SensorDot } from '../SensorDot';
import React from 'react';
import { Search } from 'lucide-react';
import { CanonicalObservation } from '../../types/fire';

interface DetectionListProps {
  items: CanonicalObservation[];
  total: number;
  selectedId: string | undefined;
  searchTerm: string;
  onSearchTerm: (v: string) => void;
  page: number;
  totalPages: number;
  pageSize: number;
  onPage: (p: number) => void;
  onInspect: (o: CanonicalObservation) => void;
}

const btn =
  'min-h-touch px-3 rounded-control bg-raised hover:bg-overlay text-fg text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors';

/** Compact, paged list of the current detections (replaces the wide table of the old layout). */
export const DetectionList: React.FC<DetectionListProps> = ({
  items,
  total,
  selectedId,
  searchTerm,
  onSearchTerm,
  page,
  totalPages,
  pageSize,
  onPage,
  onInspect,
}) => {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="space-y-2">
      <label className="relative block">
        <span className="sr-only">Filter detections by satellite, date or record ID</span>
        <Search className="h-4 w-4 text-fg-subtle absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
        <input
          id="explorer-detections-search"
          type="search"
          value={searchTerm}
          onChange={(e) => onSearchTerm(e.target.value)}
          placeholder="Satellite, date, record ID…"
          className="w-full min-h-touch bg-raised border border-line-strong rounded-control pl-9 pr-3 text-xs text-fg placeholder:text-fg-subtle"
        />
      </label>
      <ul className="space-y-1" aria-label="Hotspot detections">
        {items.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onInspect(o)}
              aria-pressed={selectedId === o.id}
              className={`w-full min-h-touch text-left px-3 py-1.5 rounded-control border transition-colors ${
                selectedId === o.id ? 'border-accent bg-accent/10' : 'border-line bg-raised/60 hover:bg-raised'
              }`}
            >
              <span className="flex items-center gap-2">
                <SensorDot sensor={o.sensor} />
                <span className="font-mono text-2xs font-bold text-fg">{o.sensor}</span>
                <span className="text-fg truncate">{o.satellite}</span>
                <span className="ml-auto numeric text-accent text-2xs shrink-0">{o.frp_mw} MW</span>
              </span>
              <span className="block numeric text-2xs text-fg-muted truncate">
                {o.acq_date} {o.acq_time} · {Number(o.latitude).toFixed(2)}°, {Number(o.longitude).toFixed(2)}°
              </span>
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="text-fg-muted py-3 text-center text-xs">
            {searchTerm
              ? 'No detections match your search filter.'
              : 'No detections loaded. Zoom in on any fire region or select a region from "Region" to load satellite detections.'}
          </li>
        )}
      </ul>
      {total > 0 && (
        <div className="flex items-center justify-between gap-2">
          <button type="button" className={btn} onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>
            Prev
          </button>
          <span className="numeric text-2xs text-fg-muted text-center">
            {from}–{to} of {total} · page {page}/{totalPages}
          </span>
          <button type="button" className={btn} onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>
            Next
          </button>
        </div>
      )}
    </div>
  );
};
