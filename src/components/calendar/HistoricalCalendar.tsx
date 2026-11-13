import React, { useEffect, useMemo, useState } from 'react';
import { Calendar as CalendarIcon, Flame } from 'lucide-react';
import { historyApi, type HistoryDailyRow } from '../../api/history';
import { InteractiveActivityChart } from '../charts/InteractiveActivityChart';
import { DAILY_VISUAL_METRICS } from '../charts/TimeseriesChart';
import { dailyVisualPoints, sensorHeatOpacity } from '../../utils/dashboardVisuals';
import { SENSOR_COLOR } from '../../utils/sensorStyle';

/**
 * Historical archive calendar (2000-2025 local FIRMS store).
 *
 * Every cell shows the REAL archive state for that day:
 *  - upper/lower stripes use independently scaled MODIS/VIIRS counts,
 *  - tooltip/detail keeps MODIS and VIIRS counts and FRP strictly separate,
 *  - a day with no archive rows is "no rows in archive" — NOT "zero fires",
 *  - a day before a sensor's coverage start is "sensor not yet launched".
 */

export interface HistoricalDayCell {
  date: string;
  modis: { detections: number; frp_sum_mw: number | null; day: number; night: number } | null;
  viirs: { detections: number; frp_sum_mw: number | null; day: number; night: number } | null;
}

interface HistoricalCalendarProps {
  /** Called when the user clicks a day; receives the archive date. */
  onInspectDate?: (date: string) => void;
  /**
   * Sensor filter from the app-level scope. When provided, only the given
   * sensor rows are fetched so the calendar matches the rest of the UI.
   * bbox scoping is not yet supported by the server-side daily aggregate;
   * tracked as a known limitation.
   */
  scope?: { sensors?: string };
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function toCell(rows: HistoryDailyRow[]): Map<string, HistoricalDayCell> {
  const map = new Map<string, HistoricalDayCell>();
  for (const r of rows) {
    if (r.country !== 'GLOBAL') continue;
    const cell = map.get(r.period) ?? { date: r.period, modis: null, viirs: null };
    const entry = {
      detections: r.detections,
      frp_sum_mw: r.frp_sum_mw,
      day: r.day_count,
      night: r.night_count,
    };
    if (r.sensor === 'MODIS') cell.modis = entry;
    else if (r.sensor === 'VIIRS') cell.viirs = entry;
    map.set(r.period, cell);
  }
  return map;
}

export const HistoricalCalendar: React.FC<HistoricalCalendarProps> = ({ onInspectDate, scope }) => {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof historyApi.status>> | null>(null);
  const [cells, setCells] = useState<Map<string, HistoricalDayCell>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [selected, setSelected] = useState<HistoricalDayCell | null>(null);

  // Derive the first sensor from the comma-separated sensors string.
  // The historical daily aggregate groups by sensor, so we pass it
  // as a filter param to match what the rest of the UI shows.
  const sensorParam = scope?.sensors?.split(',')[0]?.trim() || undefined;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      historyApi.status(),
      historyApi.daily({ global: true, level: 'daily', limit: 50000, sensor: sensorParam }),
    ])
      .then(([st, daily]) => {
        if (cancelled) return;
        setStatus(st);
        setCells(toCell(daily.rows));
        const years = Object.values(st.sensors).flatMap((s) => s.years);
        if (years.length) setYear((y) => y ?? Math.max(...years));
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sensorParam]);

  const years = useMemo(() => {
    if (!status) return [] as number[];
    return Array.from(new Set(Object.values(status.sensors).flatMap((s) => s.years))).sort((a, b) => a - b);
  }, [status]);

  const viirsStartYear = status?.sensors.VIIRS?.min_date?.slice(0, 4);
  const modisStartYear = status?.sensors.MODIS?.min_date?.slice(0, 4);

  const yearCells = useMemo(() => {
    const m = new Map<string, HistoricalDayCell>();
    if (!year) return m;
    const prefix = `${year}-`;
    for (const [date, cell] of cells) if (date.startsWith(prefix)) m.set(date, cell);
    return m;
  }, [cells, year]);

  const maxima = useMemo(() => {
    const max = { modis: 0, viirs: 0 };
    for (const c of yearCells.values()) {
      max.modis = Math.max(max.modis, c.modis?.detections ?? 0);
      max.viirs = Math.max(max.viirs, c.viirs?.detections ?? 0);
    }
    return max;
  }, [yearCells]);

  const chartPoints = useMemo(() => dailyVisualPoints([...yearCells.values()].map((cell) => ({
    date: cell.date, modis_detections: cell.modis?.detections ?? null, viirs_detections: cell.viirs?.detections ?? null,
    modis_frp_mw: cell.modis?.frp_sum_mw ?? null, viirs_frp_mw: cell.viirs?.frp_sum_mw ?? null, harmonized_activity_units: null,
  }))), [yearCells]);

  if (loading) {
    return <div className="p-6 text-sm text-fg-muted">Loading historical archive…</div>;
  }
  if (error || !status?.available) {
    return (
      <div className="p-6 text-sm text-danger">
        Historical archive unavailable{error ? `: ${error}` : '.'} Run the historical import to enable this view.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <CalendarIcon className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-fg">Historical archive calendar</h3>
        </div>
        <label className="text-xs text-fg-subtle flex items-center gap-1.5">
          Year
          <select
            value={year ?? ''}
            onChange={(e) => {
              setYear(Number(e.target.value));
              setSelected(null);
            }}
            className="bg-surface border border-line rounded-control px-2 py-1 text-xs text-fg"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
        <span className="text-2xs text-fg-subtle">
          MODIS {modisStartYear ?? '—'}–{status.sensors.MODIS?.max_date?.slice(0, 4) ?? '—'} · VIIRS S-NPP{' '}
          {viirsStartYear ?? '—'}–{status.sensors.VIIRS?.max_date?.slice(0, 4) ?? '—'} (no NOAA-20/21 in archive)
        </span>
      </div>

      <InteractiveActivityChart title="Historical daily explorer" description={`Global archive · ${year}. This aggregate is global, independent of the map area. MODIS and VIIRS are separate observation series.`}
        points={chartPoints} metrics={DAILY_VISUAL_METRICS.slice(0, 2)} onInspect={onInspectDate ? (p) => onInspectDate(p.key) : undefined} inspectLabel="Open selected archive day on map" />

      <p className="text-2xs text-fg-muted">Calendar stripes: <span style={{ color: SENSOR_COLOR.MODIS }}>■</span> upper = MODIS · <span style={{ color: SENSOR_COLOR.VIIRS }}>■</span> lower = VIIRS. Each sensor uses its own yearly intensity scale; striped backgrounds mean unavailable records.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {MONTH_NAMES.map((name, mi) => {
          const month = mi + 1;
          const first = new Date(Date.UTC(year!, month - 1, 1));
          const daysInMonth = new Date(Date.UTC(year!, month, 0)).getUTCDate();
          const lead = first.getUTCDay();
          return (
            <div key={name} className="bg-surface border border-line rounded-card p-3">
              <div className="text-xs font-semibold text-fg mb-2">{name} {year}</div>
              <div className="grid grid-cols-7 gap-1 text-center">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="text-2xs text-fg-subtle font-mono">{w}</div>
                ))}
                {Array.from({ length: lead }).map((_, i) => (
                  <div key={`pad-${i}`} />
                ))}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1;
                  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const cell = yearCells.get(dateStr);
                  const preViirs = Boolean(viirsStartYear) && year! < Number(viirsStartYear);
                  const preModis = Boolean(modisStartYear) && year! < Number(modisStartYear);
                  // Disable only when ALL selected sensors are pre-launch; if any sensor
                  // has archive coverage for this year the day remains clickable.
                  const unavailable = preModis && preViirs;
                  return (
                    <button
                      key={dateStr}
                      type="button"
                      disabled={unavailable}
                      onClick={() => {
                        setSelected(cell ?? { date: dateStr, modis: null, viirs: null });
                        onInspectDate?.(dateStr);
                      }}
                      title={
                        unavailable
                          ? `${dateStr}: before archive coverage`
                          : cell
                            ? `${dateStr}: MODIS ${cell.modis?.detections ?? 'unavailable'}, VIIRS ${cell.viirs?.detections ?? 'unavailable'} detections`
                            : `${dateStr}: no rows in archive (not proven zero activity)`
                      }
                      className={`h-7 relative overflow-hidden rounded border border-line bg-canvas text-2xs font-mono ${unavailable ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer hover:ring-1 hover:ring-accent'}`}
                    >
                      {(['modis', 'viirs'] as const).map((sensor, i) => <span key={sensor} aria-hidden="true" className="absolute left-0 right-0 h-1/2" style={{ top: `${i * 50}%`, background: cell?.[sensor] ? SENSOR_COLOR[sensor === 'modis' ? 'MODIS' : 'VIIRS'] : 'repeating-linear-gradient(135deg,var(--raised),var(--raised) 3px,var(--line) 3px,var(--line) 4px)', opacity: cell?.[sensor] ? sensorHeatOpacity(cell[sensor]!.detections, maxima[sensor]) : 0.5 }} />)}
                      <span className="relative z-10 rounded bg-canvas/70 px-0.5">{day}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="bg-surface border border-line rounded-card p-4 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-fg">{selected.date}</span>
            <button type="button" onClick={() => setSelected(null)} className="text-fg-subtle hover:text-fg">✕</button>
          </div>
          {(['MODIS', 'VIIRS'] as const).map((s) => {
            const e = s === 'MODIS' ? selected.modis : selected.viirs;
            const preStart = s === 'VIIRS' ? viirsStartYear : modisStartYear;
            return (
              <div key={s} className="flex items-center gap-2">
                <span className="font-mono text-fg-subtle w-12">{s}</span>
                {e ? (
                  <span className="text-fg">
                    {e.detections.toLocaleString()} detections · FRP {e.frp_sum_mw?.toFixed(0) ?? '—'} MW ·{' '}
                    day {e.day} / night {e.night}
                  </span>
                ) : (
                  <span className="text-fg-subtle">
                    {preStart && selected.date < `${preStart}-01-01` ? 'before satellite coverage' : 'no rows in archive'}
                  </span>
                )}
              </div>
            );
          })}
          <p className="text-2xs text-fg-subtle pt-1">
            Satellite thermal anomalies, not confirmed wildfires or burned area. MODIS and VIIRS are never added
            into one fire count; upper and lower stripes use independent per-sensor scales.
          </p>
        </div>
      )}

      <p className="text-2xs text-fg-subtle flex items-center gap-1.5">
        <Flame className="h-3 w-3" aria-hidden="true" />
        Click a day to open its real detections on the fire map (Historical mode).
      </p>
    </div>
  );
};
