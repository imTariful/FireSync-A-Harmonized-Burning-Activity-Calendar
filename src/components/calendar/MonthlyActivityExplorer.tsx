import React, { useMemo, useState } from 'react';
import type { AgniLayer, AgniMonthRow } from '../../api/agnicalendar';
import { monthlyVisualPoints, type VisualMetric } from '../../utils/dashboardVisuals';
import { InteractiveActivityChart } from '../charts/InteractiveActivityChart';

export function MonthlyActivityExplorer({ rows, startYear, endYear, layer, onInspect }: {
  rows: AgniMonthRow[]; startYear: number; endYear: number; layer: AgniLayer; onInspect: (period: { year: number; month: number }) => void;
}) {
  const [chosenYear, setChosenYear] = useState(endYear);
  const year = Math.max(startYear, Math.min(chosenYear, endYear));
  const points = useMemo(() => monthlyVisualPoints(rows, year), [rows, year]);
  const label = layer === 'aqua' ? 'MODIS Aqua' : layer === 'snpp' ? 'VIIRS SNPP' : 'EXPLORATORY Aqua-equivalent estimate';
  const metrics: VisualMetric[] = [
    { key: 'activity', label: layer === 'harmonized' ? 'EXPLORATORY estimated activity' : 'Observed detections', unit: layer === 'harmonized' ? 'estimated detections' : 'detections', series: [{ key: 'activity', label, color: layer === 'aqua' ? '#b81d3f' : layer === 'snpp' ? '#eab308' : '#22d3ee' }], note: 'UTC-month aggregates on the 10-km grid. RF-B harmonized estimates use approved joint-positive support only (EXPLORATORY), not a complete corrected series.' },
    { key: 'frp', label: 'Source FRP sum', unit: 'MW', series: [{ key: 'frp', label: 'Source FRP', color: '#fb923c' }], note: 'Source-reported FRP summed within the selected monthly product. Not radiated energy, burned area or model-predicted FRP.' },
    { key: 'cells', label: 'Grid cells with data', unit: 'cells', series: [{ key: 'cells', label: 'Cells with data', color: '#a78bfa' }], note: 'Cells containing a record in the selected product, not a measurement of complete satellite observation coverage.' },
  ];
  return <div className="space-y-3">
    <label className="inline-flex items-center gap-2 text-xs text-fg-muted">Explore a year <select aria-label="Monthly chart year" value={year} onChange={(e) => setChosenYear(Number(e.target.value))} className="min-h-11 bg-surface text-fg border border-line rounded-control px-3">{Array.from({ length: endYear - startYear + 1 }, (_, i) => startYear + i).map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
    <InteractiveActivityChart title="Monthly activity explorer" description={`${label} · ${year} · selected region, day/night and fire type. Monthly values stay monthly.`} points={points} metrics={metrics}
      onInspect={(p) => onInspect({ year, month: Number(p.key.slice(5, 7)) })} inspectLabel="Inspect this month below" />
  </div>;
}
