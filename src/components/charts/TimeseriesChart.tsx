import React, { useMemo } from 'react';
import type { DailyActivitySummary } from '../../types/fire';
import { SENSOR_COLOR } from '../../utils/sensorStyle';
import { dailyVisualPoints, type VisualMetric } from '../../utils/dashboardVisuals';
import { InteractiveActivityChart } from './InteractiveActivityChart';

export const DAILY_VISUAL_METRICS: VisualMetric[] = [
  { key: 'detections', label: 'Sensor detections', unit: 'detections', series: [{ key: 'modis', label: 'MODIS', color: SENSOR_COLOR.MODIS }, { key: 'viirs', label: 'VIIRS', color: SENSOR_COLOR.VIIRS }], note: 'MODIS and VIIRS counts stay separate; more detections do not mean more unique fires.' },
  { key: 'frp', label: 'Sensor FRP', unit: 'MW', series: [{ key: 'modisFrp', label: 'MODIS FRP', color: SENSOR_COLOR.MODIS }, { key: 'viirsFrp', label: 'VIIRS FRP', color: SENSOR_COLOR.VIIRS }], note: 'Sum of source-reported fire radiative power within each sensor and UTC day; not energy or burned area.' },
  { key: 'bau', label: 'EXPLORATORY harmonized activity', unit: 'BAU', series: [{ key: 'bau', label: 'EXPLORATORY activity', color: '#22d3ee' }], note: 'EXPLORATORY 1-km equivalent activity from the existing harmonization method; not a validated fire count. See Methodology for calibration limitations.' },
];

export function TimeseriesChart({ dailySummaries, title = 'Daily activity explorer', onInspectDate }: {
  dailySummaries: DailyActivitySummary[]; title?: string; onInspectDate?: (date: string) => void;
}) {
  const points = useMemo(() => dailyVisualPoints(dailySummaries), [dailySummaries]);
  return <InteractiveActivityChart title={title} description="Explore UTC days with bars or lines. Hover, tap or move the slider to inspect a date; toggle sensors in the legend."
    points={points} metrics={DAILY_VISUAL_METRICS} onInspect={onInspectDate ? (p) => onInspectDate(p.key) : undefined} inspectLabel="Open selected day on map" />;
}
