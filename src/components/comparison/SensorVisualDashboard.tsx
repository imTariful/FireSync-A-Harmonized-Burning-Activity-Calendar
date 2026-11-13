import React, { useId, useState } from 'react';
import type { SensorComparisonResponse } from '../../api/client';
import { SENSOR_COLOR, SENSOR_FOOTPRINT_M } from '../../utils/sensorStyle';
import type { VisualMetric, VisualPoint } from '../../utils/dashboardVisuals';
import { InteractiveActivityChart } from '../charts/InteractiveActivityChart';
import { FIRE_LEGEND } from '../../types/ai';

const metrics: VisualMetric[] = [
  { key: 'counts', label: 'Source detections', unit: 'detections', series: [{ key: 'modis', label: 'MODIS', color: SENSOR_COLOR.MODIS }, { key: 'viirs', label: 'VIIRS', color: SENSOR_COLOR.VIIRS }], note: 'Same filtered live window. Detections are source records, not unique fires. Raw sensor counts are not summed.' },
  { key: 'frp', label: 'Source FRP sums', unit: 'MW', series: [{ key: 'modisFrp', label: 'MODIS FRP', color: SENSOR_COLOR.MODIS }, { key: 'viirsFrp', label: 'VIIRS FRP', color: SENSOR_COLOR.VIIRS }], note: 'Per-sensor sums of reported FRP across the selected window. Simultaneous observations can overlap; not a combined energy estimate.' },
];

export function SensorVisualDashboard({ data, loading, error }: { data: SensorComparisonResponse | null; loading: boolean; error: string | null }) {
  const [focus, setFocus] = useState<'both' | 'MODIS' | 'VIIRS'>('both');
  const gridId = useId();
  const comparison = data?.comparison;
  const points: VisualPoint[] = comparison ? [{ key: 'window', label: 'Selected window', values: {
    modis: comparison.modis_total_detections, viirs: comparison.viirs_total_detections,
    modisFrp: comparison.frp.modis_total_mw, viirsFrp: comparison.frp.viirs_total_mw,
  } }] : [];
  return <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
    <div className="space-y-3">
      {loading && <p role="status" className="text-xs text-fg-muted">Loading sensor observations for the current filters…</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <InteractiveActivityChart title="Sensor signal comparison" description="Compare each sensor on the same scale. Switch between observation counts and reported radiative power." points={points} metrics={metrics} />
      {comparison && <p className="text-2xs text-fg-muted">Source: {comparison.data_source} · retrieved {comparison.retrieved_at ?? 'unknown'}{comparison.cached ? ' · cached response' : ''}{comparison.truncated ? ' · PARTIAL / truncated response' : ''}{comparison.source_errors?.length ? ` · source errors: ${comparison.source_errors.join('; ')}` : ''}</p>}
    </div>
    <section aria-label="Sensor footprint diagram" className="bg-surface border border-line rounded-card p-5 space-y-4">
      <div><p className="text-2xs uppercase tracking-widest text-accent font-semibold">Understand the difference</p><h3 className="text-base font-bold mt-1">Two sensors, different footprints</h3><p className="text-xs text-fg-muted mt-1">Both squares use the same spatial scale at nadir. Select a sensor to highlight its footprint.</p></div>
      <div role="group" aria-label="Footprint focus" className="flex flex-wrap gap-2">{(['both', 'MODIS', 'VIIRS'] as const).map((sensor) => <button key={sensor} type="button" aria-pressed={focus === sensor} onClick={() => setFocus(sensor)} className={`min-h-11 px-3 rounded-control border text-xs ${focus === sensor ? 'bg-accent text-accent-fg border-accent' : 'bg-canvas border-line text-fg-muted'}`}>{sensor === 'both' ? 'Compare both' : sensor}</button>)}</div>
      <svg role="img" aria-label="Same-scale nadir footprints: MODIS 1000 metres and VIIRS 375 metres" viewBox="0 0 460 250" className="w-full bg-canvas rounded-control border border-line">
        <defs><pattern id={gridId} width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--line)" strokeWidth={0.5} /></pattern></defs>
        <rect width={460} height={250} fill={`url(#${gridId})`} />
        {(['MODIS', 'VIIRS'] as const).map((sensor, i) => {
          const side = SENSOR_FOOTPRINT_M[sensor] * 0.16, x = i === 0 ? 45 : 315;
          return <g key={sensor} opacity={focus === 'both' || focus === sensor ? 1 : 0.2}>
            <rect x={x} y={185 - side} width={side} height={side} fill={SENSOR_COLOR[sensor]} fillOpacity={0.2} stroke={SENSOR_COLOR[sensor]} strokeWidth={3} />
            <text x={x + side / 2} y={210} fill="var(--fg)" fontSize={13} textAnchor="middle">{sensor}</text><text x={x + side / 2} y={229} fill="var(--fg-muted)" fontSize={11} textAnchor="middle">{SENSOR_FOOTPRINT_M[sensor]} m × {SENSOR_FOOTPRINT_M[sensor]} m</text>
          </g>;
        })}
      </svg>
      <p aria-live="polite" className="text-xs text-fg-muted">{focus === 'MODIS' ? 'MODIS: the nominal nadir pixel is 1 km wide. Its observation count must be interpreted separately from the smaller VIIRS pixels.' : focus === 'VIIRS' ? 'VIIRS: the nominal nadir pixel is 375 m wide. A larger observation count can reflect pixel size and sampling rather than more distinct fires.' : 'The same scene can produce different detection counts because the instruments sample it differently. Pixel size is not a fire perimeter or a burned-area measurement.'}</p>
      <p className="text-2xs text-fg-subtle">Schematic only, not an observed satellite scene. Footprints vary away from nadir. {FIRE_LEGEND}</p>
    </section>
  </div>;
}
