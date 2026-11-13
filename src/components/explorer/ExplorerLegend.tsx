import React from 'react';
import {
  LEGEND_SWATCH_PX,
  SENSOR_COLOR,
  SENSOR_FOOTPRINT_M,
  SENSOR_NAMES,
  SENSOR_RING_COLOR,
  type SensorName,
} from '../../utils/sensorStyle';

export interface ExplorerLegendProps {
  /** Detections on screen per sensor. MODIS and VIIRS are counted separately and never summed. */
  counts: Record<SensorName, number>;
  /** With a timeline: the loaded totals, shown as "of N". */
  ofCounts?: Record<SensorName, number> | null;
  /** What the detections are: "Live NASA FIRMS, last 2 days", "Archive (bundled sample)", ... */
  sourceLabel: string;
  updatedLabel?: string | null;
  cached?: boolean;
  /** Non-blocking notes (very large result, a source did not answer). Never raw server text. */
  notes?: string[];
  /** Extra classes from the map (position lift, hidden under the inspector). */
  className?: string;
}

const SATELLITES: Record<SensorName, string> = { MODIS: 'Terra + Aqua', VIIRS: 'NOAA-20 + NOAA-21' };

/** Swatch with the same size ratio as the dots on the map (MODIS also has its light ring). */
export const SensorSwatch: React.FC<{ sensor: SensorName }> = ({ sensor }) => {
  const d = LEGEND_SWATCH_PX[sensor];
  const box = LEGEND_SWATCH_PX.MODIS + 4; // same width for both, so the labels line up
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center" style={{ width: box, height: box }}>
      <span
        className="block rounded-full"
        style={{
          width: d,
          height: d,
          backgroundColor: SENSOR_COLOR[sensor],
          boxShadow: sensor === 'MODIS' ? `0 0 0 1.5px ${SENSOR_RING_COLOR}` : '0 0 0 1px rgba(5,7,13,0.6)',
        }}
      />
    </span>
  );
};

/** THE legend of the Explorer (one only): counts per sensor, what the size and the cloud mean, and the caveat. */
export const ExplorerLegend: React.FC<ExplorerLegendProps> = ({
  counts,
  ofCounts = null,
  sourceLabel,
  updatedLabel = null,
  cached = false,
  notes = [],
  className = '',
}) => (
  <div
    className={`absolute z-10 inset-x-2 bottom-[var(--legend-bottom)] sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(29.5rem,calc(100%-2rem))] pointer-events-none ${className}`}
  >
    <div className="glass-panel popup-enter rounded-card bg-surface/80 hover:bg-surface/90 backdrop-blur-xl border border-line-strong/60 px-3 py-1.5 text-xs space-y-0.5 shadow-elev-3 transition-all duration-300">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        {SENSOR_NAMES.map((s) => (
          <span key={s} className="flex items-center gap-1.5 text-fg font-medium" data-testid={`count-${s}`}>
            <SensorSwatch sensor={s} />
            <span className="font-semibold">{s}</span>
            <span className="numeric">{counts[s].toLocaleString()}</span>
            {ofCounts && <span className="text-fg-subtle numeric">of {ofCounts[s].toLocaleString()}</span>}
            <span className="text-fg-subtle text-2xs max-sm:hidden">
              ({SATELLITES[s]}, {s === 'MODIS' ? '1 km' : '375 m'})
            </span>
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between text-2xs text-fg-muted leading-tight">
        <span>
          <span className="text-fg">{sourceLabel}</span>
          {updatedLabel && (
            <span className="max-sm:hidden">
              {' '}
              · updated <span className="numeric text-fg">{updatedLabel}</span>
              {cached && <span className="text-fg-subtle"> (cached, 30m)</span>}
            </span>
          )}
        </span>
        {notes.length > 0 && <span className="text-accent text-2xs">{notes.join(' · ')}</span>}
      </div>
      <div className="text-[10px] leading-tight text-fg-muted">Satellite thermal anomalies, not confirmed wildfires or burned area.</div>
      <div className="text-[9.5px] leading-tight text-fg-subtle">
        {`Dot size = pixel footprint: MODIS ${SENSOR_FOOTPRINT_M.MODIS / 1000} km, VIIRS ${SENSOR_FOOTPRINT_M.VIIRS} m; cloud intensity = FRP. MODIS and VIIRS are shown separately, never merged.`}
      </div>
    </div>
  </div>
);
