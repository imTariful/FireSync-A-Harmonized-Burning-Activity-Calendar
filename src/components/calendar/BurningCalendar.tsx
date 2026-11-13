import { SensorDot } from '../SensorDot';
import React, { useEffect, useMemo, useState } from 'react';
import { Calendar as CalendarIcon, Flame, X, ExternalLink, Info } from 'lucide-react';
import { DailyActivitySummary } from '../../types/fire';

interface BurningCalendarProps {
  dailySummaries: DailyActivitySummary[];
  /** Name of the area the data belongs to (shown in the day details). */
  areaName: string;
  onInspectDateOnMap?: (date: string) => void;
  /** Year to show (for example when a year is picked in the month/year heatmap). */
  year?: number;
}

export const BurningCalendar: React.FC<BurningCalendarProps> = ({
  dailySummaries,
  areaName,
  onInspectDateOnMap,
  year,
}) => {
  // Years come from the data (not a fixed list), so a 2000-to-today record works unchanged.
  const availableYears = useMemo(
    () => Array.from(new Set<number>(dailySummaries.map((d) => d.year))).sort((a: number, b: number) => a - b),
    [dailySummaries]
  );
  const [selectedYear, setSelectedYear] = useState<number>(
    () => year ?? availableYears[availableYears.length - 1] ?? new Date().getUTCFullYear()
  );
  const [selectedDay, setSelectedDay] = useState<DailyActivitySummary | null>(null);

  useEffect(() => {
    if (year !== undefined) setSelectedYear(year);
  }, [year]);

  useEffect(() => {
    if (availableYears.length > 0 && !availableYears.includes(selectedYear)) {
      setSelectedYear(availableYears[availableYears.length - 1]);
    }
  }, [availableYears, selectedYear]);

  // Filter summaries for current selected year
  const yearSummaries = dailySummaries.filter((d) => d.year === selectedYear);

  // Group by month (1 to 12)
  const months = [
    { num: 1, name: 'January' },
    { num: 2, name: 'February' },
    { num: 3, name: 'March' },
    { num: 4, name: 'April' },
    { num: 5, name: 'May' },
    { num: 6, name: 'June' },
    { num: 7, name: 'July' },
    { num: 8, name: 'August' },
    { num: 9, name: 'September' },
    { num: 10, name: 'October' },
    { num: 11, name: 'November' },
    { num: 12, name: 'December' },
  ];

  // Modern color coding for activity intensity
  const getActivityColor = (day?: DailyActivitySummary) => {
    if (!day || day.total_raw_detections === 0) {
      return 'bg-raised/60 border-line/60 text-fg-subtle hover:border-line-strong hover:text-fg';
    }
    const val = day.harmonized_activity_units;
    if (day.anomaly_category === 'extreme_anomaly') {
      return 'bg-rose-600 border-rose-400 text-white font-bold shadow-sm';
    }
    if (day.anomaly_category === 'high_anomaly') {
      return 'bg-orange-600 border-orange-400 text-white font-bold shadow-sm';
    }
    if (val >= 15) {
      return 'bg-amber-600 border-amber-400 text-white font-medium shadow-sm';
    }
    if (val >= 5) {
      return 'bg-amber-500/50 border-amber-500/60 text-amber-100 font-medium';
    }
    return 'bg-amber-500/20 border-amber-500/30 text-amber-300';
  };

  const getAccessibilitySymbol = (day?: DailyActivitySummary) => {
    if (!day) return null;
    if (day.anomaly_category === 'extreme_anomaly') return '⚡';
    if (day.anomaly_category === 'high_anomaly') return '▲';
    if (day.anomaly_category === 'moderate_anomaly') return '•';
    return null;
  };

  return (
    <div className="space-y-4">
      {/* Calendar Header with Year Segmented Control */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface border border-line p-4 rounded-card shadow-elev-1">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-control bg-raised flex items-center justify-center shrink-0">
            <CalendarIcon className="h-4 w-4 text-accent" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-fg">
              Harmonized Burning-Activity Calendar
            </h2>
            <p className="text-xs text-fg-muted">
              Daily spatial-temporal activity with non-parametric seasonal MAD anomaly evaluation
            </p>
          </div>
        </div>

        {/* Year Segmented Switcher */}
        <div className="flex items-center space-x-1 bg-raised p-1 rounded-control border border-line max-w-full overflow-x-auto scrollbar-none" role="group" aria-label="Year">
          {availableYears.map((yr) => (
            <button
              key={yr}
              onClick={() => setSelectedYear(yr)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                selectedYear === yr
                  ? 'bg-accent text-accent-fg font-bold shadow-elev-1'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              {yr}
            </button>
          ))}
        </div>
      </div>

      {/* Legend & Scientific Disclaimer */}
      <div className="bg-surface border border-line rounded-card px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-4 flex-wrap">
          <span className="text-fg-muted text-xs">Scale:</span>
          <div className="flex items-center space-x-1.5">
            <span className="h-3 w-3 rounded bg-raised border border-line" />
            <span className="text-fg-subtle">Zero</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="h-3 w-3 rounded bg-amber-500/20 border border-amber-500/30" />
            <span className="text-fg-muted">Low (1–5 BAU)</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="h-3 w-3 rounded bg-amber-600 border border-amber-400" />
            <span className="text-fg">Moderate (&gt;15 BAU)</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="h-3 w-3 rounded bg-orange-600 border border-orange-400" />
            <span className="text-fg">High Anomaly (▲)</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="h-3 w-3 rounded bg-rose-600 border border-rose-400" />
            <span className="text-danger font-semibold">Extreme Anomaly (⚡)</span>
          </div>
        </div>

        <div className="flex items-center space-x-1.5 text-fg-subtle text-2xs italic">
          <Info className="h-3.5 w-3.5 text-info shrink-0" aria-hidden="true" />
          <span>Historical activity anomalies reflect statistical variance, not fire forecasts.</span>
        </div>
      </div>

      {/* 12-Month Calendar Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {months.map((m) => {
          const daysInMonth = new Date(selectedYear, m.num, 0).getDate();
          const firstDayOffset = new Date(selectedYear, m.num - 1, 1).getDay();
          const daysArray = Array.from({ length: daysInMonth }, (_, i) => i + 1);

          return (
            <div
              key={m.num}
              className="bg-surface border border-line rounded-card p-3.5 flex flex-col justify-between card-hover"
            >
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-line">
                <span className="font-semibold text-fg text-xs">{m.name}</span>
                <span className="text-2xs text-fg-subtle font-mono tabular-nums">{selectedYear}</span>
              </div>

              {/* Day of week headers */}
              <div className="grid grid-cols-7 gap-1 text-center text-[9px] text-fg-subtle font-medium mb-1">
                <span>Su</span>
                <span>Mo</span>
                <span>Tu</span>
                <span>We</span>
                <span>Th</span>
                <span>Fr</span>
                <span>Sa</span>
              </div>

              {/* Days grid */}
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: firstDayOffset }).map((_, idx) => (
                  <div key={`empty-${idx}`} className="h-6 w-full" />
                ))}

                {daysArray.map((dayNum) => {
                  const dateStr = `${selectedYear}-${String(m.num).padStart(2, '0')}-${String(
                    dayNum
                  ).padStart(2, '0')}`;
                  const dayData = yearSummaries.find((d) => d.date === dateStr);
                  const isSelected = selectedDay?.date === dateStr;
                  const symbol = getAccessibilitySymbol(dayData);

                  return (
                    <button
                      key={dayNum}
                      onClick={() => dayData && setSelectedDay(dayData)}
                      disabled={!dayData}
                      title={
                        dayData
                          ? `${dateStr}: ${dayData.harmonized_activity_units} Harmonized Units, ${dayData.total_raw_detections} Hotspots`
                          : dateStr
                      }
                      className={`h-6 w-full rounded text-[10px] font-mono tabular-nums flex items-center justify-center relative border transition-all cursor-pointer ${getActivityColor(
                        dayData
                      )} ${isSelected ? 'ring-2 ring-accent z-10' : ''}`}
                    >
                      <span>{dayNum}</span>
                      {symbol && (
                        <span className="absolute -top-1 -right-1 text-[8px] leading-none" aria-hidden="true">
                          {symbol}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Selected Day Inspector Modal */}
      {selectedDay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-canvas/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-surface border border-line rounded-card max-w-lg w-full p-5 text-fg shadow-elev-3 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-line">
              <div className="flex items-center space-x-2.5">
                <div className="h-8 w-8 rounded-control bg-raised flex items-center justify-center">
                  <Flame className="h-4 w-4 text-accent" aria-hidden="true" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-fg font-mono tabular-nums">
                    {selectedDay.date}
                  </h3>
                  <p className="text-xs text-fg-muted">
                    Day {selectedDay.day_of_year} · {areaName}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedDay(null)}
                className="text-fg-muted hover:text-fg p-1.5 rounded-control hover:bg-raised transition"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* Harmonized Unit Metrics */}
            <div className="bg-raised p-4 rounded-control border border-line grid grid-cols-2 gap-4 text-center">
              <div>
                <span className="text-xs text-fg-muted font-medium">Harmonized Activity</span>
                <div className="text-2xl font-extrabold text-accent font-mono tabular-nums mt-1">
                  {selectedDay.harmonized_activity_units}
                  <span className="text-xs font-normal text-fg-muted ml-1">BAU</span>
                </div>
                <span className="text-2xs text-fg-subtle">1-km Standard Equivalent</span>
              </div>

              <div>
                <span className="text-xs text-fg-muted font-medium">Total Fire Radiative Power</span>
                <div className="text-2xl font-extrabold text-danger font-mono tabular-nums mt-1">
                  {selectedDay.total_frp_mw}
                  <span className="text-xs font-normal text-fg-muted ml-1">MW</span>
                </div>
                <span className="text-2xs text-fg-subtle">Mean: {selectedDay.mean_frp_mw} MW</span>
              </div>
            </div>

            {/* Raw Sensor Breakdown */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-raised p-3 rounded-control border border-line">
                <div className="flex items-center justify-between text-xs font-semibold text-fg">
                  <span className="flex items-center gap-1.5">
                    <SensorDot sensor="MODIS" />
                    MODIS (1 km)
                  </span>
                  <span className="font-mono tabular-nums">{selectedDay.modis_detections}</span>
                </div>
                <div className="text-2xs text-fg-muted mt-1 font-mono tabular-nums">
                  FRP: {selectedDay.modis_frp_mw} MW
                </div>
                <div className="text-2xs text-fg-subtle mt-0.5">Terra &amp; Aqua Overpasses</div>
              </div>

              <div className="bg-raised p-3 rounded-control border border-line">
                <div className="flex items-center justify-between text-xs font-semibold text-fg">
                  <span className="flex items-center gap-1.5">
                    <SensorDot sensor="VIIRS" />
                    VIIRS (375 m)
                  </span>
                  <span className="font-mono tabular-nums">{selectedDay.viirs_detections}</span>
                </div>
                <div className="text-2xs text-fg-muted mt-1 font-mono tabular-nums">
                  FRP: {selectedDay.viirs_frp_mw} MW
                </div>
                <div className="text-2xs text-fg-subtle mt-0.5">Suomi-NPP &amp; NOAA-20</div>
              </div>
            </div>

            {/* Historical Baseline Statistics */}
            <div className="bg-raised p-3.5 rounded-control border border-line space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-fg-muted">Seasonal Baseline (Month {selectedDay.month}):</span>
                <span className="font-mono tabular-nums text-fg">
                  Median: {selectedDay.historical_baseline_median} · MAD: {selectedDay.historical_baseline_mad}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-muted">Robust Anomaly Z-Score:</span>
                <span
                  className={`font-mono tabular-nums font-bold ${
                    selectedDay.anomaly_score >= 2.5 ? 'text-danger' : 'text-fg'
                  }`}
                >
                  Z = {selectedDay.anomaly_score} ({selectedDay.anomaly_category.replace('_', ' ')})
                </span>
              </div>
              <div className="flex items-center justify-between text-2xs text-fg-muted pt-1 border-t border-line">
                <span>Active 1-km Equal-Area Cells:</span>
                <span className="font-mono tabular-nums text-fg">{selectedDay.active_1km_cells} cells</span>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => {
                  if (onInspectDateOnMap) {
                    onInspectDateOnMap(selectedDay.date);
                  }
                  setSelectedDay(null);
                }}
                className="flex items-center space-x-1.5 px-4 min-h-touch rounded-control bg-accent hover:bg-accent-hover text-accent-fg font-bold text-xs transition shadow-elev-1"
              >
                <span>Inspect Day on Map</span>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
