/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Archive, Download } from 'lucide-react';
import { historyApi, type HistoryStatus } from '../../api/history';

/**
 * CSV downloads from the local historical FIRMS archive (2000-2025).
 * MODIS and VIIRS are filtered separately; the archive never merges them.
 */
export const HistoricalExports: React.FC = () => {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [year, setYear] = useState<number>(2025);
  const [sensor, setSensor] = useState<string>('ALL');
  const [level, setLevel] = useState<'daily' | 'monthly'>('daily');
  const [obsDate, setObsDate] = useState('');
  const [anomalyMonth, setAnomalyMonth] = useState<number>(8);

  useEffect(() => {
    historyApi
      .status()
      .then((s) => {
        setStatus(s);
        if (!s.available) return;
        const years = new Set<number>();
        for (const sensorEntry of Object.values(s.sensors)) for (const y of sensorEntry.years) years.add(y);
        const sorted = [...years].sort((a, b) => a - b);
        if (sorted.length) setYear(sorted[sorted.length - 1]);
      })
      .catch(() => setStatus(null));
  }, []);

  if (!status?.available) return null;

  const allYears = (() => {
    const set = new Set<number>();
    for (const s of Object.values(status.sensors)) for (const y of s.years) set.add(y);
    return [...set].sort((a, b) => a - b);
  })();

  const dailyParams: Record<string, string | number | undefined> = {
    year,
    level,
    global: 'true',
    sensor: sensor === 'ALL' ? undefined : sensor,
  };
  const obsParams: Record<string, string | number | undefined> = {
    date: obsDate || undefined,
    sensor: sensor === 'ALL' ? undefined : sensor,
  };
  const monthAnomalyParams: Record<string, string | number | undefined> = {
    sensor: sensor === 'ALL' ? undefined : sensor,
    year,
    month: anomalyMonth,
  };

  const btn =
    'inline-flex items-center justify-center gap-1.5 min-h-touch px-3 rounded-control bg-raised hover:bg-overlay text-fg text-xs font-medium border border-line transition-colors';

  return (
    <section aria-labelledby="hist-exports-title" className="bg-surface border border-line rounded-card p-5 space-y-4 shadow-elev-1">
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-control bg-raised border border-line flex items-center justify-center shrink-0">
          <Archive className="h-4 w-4 text-accent" aria-hidden="true" />
        </div>
        <div>
          <h3 id="hist-exports-title" className="font-bold text-fg text-sm">Historical archive exports (2000–2025)</h3>
          <p className="text-2xs text-fg-muted">
            Local FIRMS ZIP archive in Parquet. Counts are satellite thermal anomalies, not confirmed wildfires.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-2xs text-fg-subtle">
          Year
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="block mt-1 bg-raised border border-line rounded-control px-2 py-1.5 text-xs text-fg numeric"
          >
            {allYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="text-2xs text-fg-subtle">
          Sensor
          <select
            value={sensor}
            onChange={(e) => setSensor(e.target.value)}
            className="block mt-1 bg-raised border border-line rounded-control px-2 py-1.5 text-xs text-fg"
          >
            <option value="ALL">All (separate rows)</option>
            <option value="MODIS">MODIS</option>
            <option value="VIIRS">VIIRS</option>
          </select>
        </label>
        <label className="text-2xs text-fg-subtle">
          Aggregation
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value === 'monthly' ? 'monthly' : 'daily')}
            className="block mt-1 bg-raised border border-line rounded-control px-2 py-1.5 text-xs text-fg"
          >
            <option value="daily">Daily</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label className="text-2xs text-fg-subtle">
          Observation date (YYYY-MM-DD)
          <input
            type="date"
            value={obsDate}
            onChange={(e) => setObsDate(e.target.value)}
            className="block mt-1 bg-raised border border-line rounded-control px-2 py-1.5 text-xs text-fg numeric"
          />
        </label>
        <label className="text-2xs text-fg-subtle">
          Anomaly month
          <select
            value={anomalyMonth}
            onChange={(e) => setAnomalyMonth(Number(e.target.value))}
            className="block mt-1 bg-raised border border-line rounded-control px-2 py-1.5 text-xs text-fg"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {String(m).padStart(2, '0')}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <a className={btn} href={historyApi.exportUrl('daily', dailyParams)} download>
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Daily/monthly summary CSV
        </a>
        <a
          className={btn}
          href={historyApi.exportUrl('observations', obsParams)}
          download
          aria-disabled={!obsDate}
          style={obsDate ? undefined : { opacity: 0.5, pointerEvents: 'none' }}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Observations CSV (pick a date)
        </a>
        <a className={btn} href={historyApi.exportUrl('coverage', { sensor: sensor === 'ALL' ? undefined : sensor })} download>
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Coverage CSV
        </a>
        <a className={btn} href={historyApi.exportUrl('frp-extremes', { sensor: sensor === 'ALL' ? undefined : sensor })} download>
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> FRP extremes CSV
        </a>
        <a className={btn} href={historyApi.exportUrl('persistence', { sensor: sensor === 'ALL' ? undefined : sensor })} download>
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Persistent countries CSV
        </a>
        <a className={btn} href={historyApi.exportUrl('month-anomaly', monthAnomalyParams)} download>
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Month anomaly CSV
        </a>
      </div>

      <p className="text-2xs text-fg-subtle">
        Archive totals: MODIS {status.sensors.MODIS?.rows?.toLocaleString() ?? '—'} detections (
        {status.sensors.MODIS?.min_date ?? '?'} → {status.sensors.MODIS?.max_date ?? '?'}), VIIRS{' '}
        {status.sensors.VIIRS?.rows?.toLocaleString() ?? '—'} ({status.sensors.VIIRS?.min_date ?? '?'} →{' '}
        {status.sensors.VIIRS?.max_date ?? '?'}). VIIRS is Suomi-NPP only.
      </p>
    </section>
  );
};
