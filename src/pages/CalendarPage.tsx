/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Calendar as CalendarIcon, Download, Flame, AlertTriangle, Info, Database, History, CalendarRange } from 'lucide-react';
import { DailyActivitySummary, FilterState } from '../types/fire';
import type { Area, AreaScope } from '../utils/area';
import { BurningCalendar } from '../components/calendar/BurningCalendar';
import { HistoricalCalendar } from '../components/calendar/HistoricalCalendar';
import { SeasonalOutlookPanel } from '../components/seasonal/SeasonalOutlookPanel';
import { api, liveObservationQuery } from '../api/client';
import { MonthYearHeatmap } from '../components/calendar/MonthYearHeatmap';
import { MonthComparisonCard } from '../components/calendar/MonthComparisonCard';
import { AgniCalendarPage } from './AgniCalendarPage';
import { WatchlistPanel } from '../components/ai/WatchlistPanel';
import type { AnalysisOverlay } from '../utils/geoOverlays';
import { areaToScope, bboxToString } from '../utils/area';
import { FIRE_LEGEND } from '../types/ai';
import { TimeseriesChart } from '../components/charts/TimeseriesChart';

export type DataSourceMode = 'live' | 'historical';
export type CalendarView = 'daily' | 'monthly' | 'monitoring';

interface CalendarPageProps {
  dailySummaries: DailyActivitySummary[];
  area: Area;
  filters: FilterState;
  /** Same area and sensor as the data on screen, so the CSV matches it. */
  scope?: AreaScope;
  onNavigateToMapWithDate: (date: string) => void;
  /** Live = 5-day NRT window; Historical = local 2000-2025 archive. */
  sourceMode?: DataSourceMode;
  onSourceModeChange?: (mode: DataSourceMode) => void;
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
  selectedArea?: Area | null;
  onShowOverlay?: (overlay: AnalysisOverlay) => void;
}

export const CalendarPage: React.FC<CalendarPageProps> = ({
  dailySummaries,
  area,
  filters,
  scope,
  onNavigateToMapWithDate,
  sourceMode = 'live',
  onSourceModeChange,
  view,
  onViewChange,
  selectedArea,
  onShowOverlay,
}) => {
  const [year, setYear] = React.useState<number | undefined>(undefined);

  const downloadCalendarCsv = () => {
    let url: string;
    if (sourceMode === 'historical') {
      // Historical export: use the historical daily CSV route with year/sensor/bbox.
      const params = new URLSearchParams();
      if (year !== undefined) params.set('year', String(year));
      if (scope?.sensors) params.set('sensor', scope.sensors.split(',')[0].trim());
      if (scope?.bbox) params.set('bbox', scope.bbox);
      params.set('level', 'daily');
      params.set('global', 'true');
      url = `/api/v1/history/export/daily.csv?${params.toString()}`;
    } else {
      url = api.getExportCalendarCsvUrl(liveObservationQuery(filters, scope));
    }
    window.location.href = url;
  };

  const activeDaysCount = dailySummaries.filter((d) => d.total_raw_detections > 0).length;
  const scoredDays = dailySummaries.filter((d) => d.anomaly_category !== 'insufficient_data').length;
  const anomalyDaysCount = dailySummaries.filter(
    (d) => d.anomaly_category === 'high_anomaly' || d.anomaly_category === 'extreme_anomaly'
  ).length;

  return (
    <div className="space-y-6 page-enter">
      <section className="bg-surface border border-line rounded-card p-5 space-y-3">
        <h1 className="text-lg font-bold">Calendar</h1>
        <p className="text-xs text-fg-muted">Burning Calendar and AgniCalendar together, with live regional monitoring. Historical patterns describe past observations; monitoring checks newly reported observations. Neither predicts future fires.</p>
        <div role="group" aria-label="Calendar view" className="flex flex-wrap gap-2">
          {([
            ['daily', 'Daily calendar'],
            ['monthly', 'Monthly AgniCalendar'],
            ['monitoring', 'Early monitoring'],
          ] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={view === id} onClick={() => onViewChange(id)}
              className={`min-h-touch px-4 rounded-control text-xs font-semibold ${view === id ? 'bg-accent text-accent-fg' : 'bg-raised text-fg-muted hover:text-fg'}`}>{label}</button>
          ))}
        </div>
        <p className="text-2xs text-fg-subtle">{FIRE_LEGEND}</p>
      </section>

      {view === 'monthly' ? (
        <AgniCalendarPage onShowOverlay={onShowOverlay} mapScope={selectedArea ? areaToScope(selectedArea) : undefined} mapAreaName={selectedArea?.name} />
      ) : view === 'monitoring' ? (
        <section className="bg-surface border border-line rounded-card p-5 sm:p-6 space-y-3">
          <h2 className="text-base font-bold">Early monitoring & alerts</h2>
          <p className="text-xs text-fg-muted">Live NASA FIRMS observations only. These alerts are independent of the calendar date filters and historical monthly estimates. No fire prediction or ignition-time claim.</p>
          <WatchlistPanel context={{ active_view: 'calendar', area_name: selectedArea?.name }}
            monitoringArea={selectedArea ? { name: selectedArea.name, bbox: bboxToString(selectedArea.bbox), polygon: Boolean(selectedArea.polygon) } : undefined}
            inlineAreaSelection />
        </section>
      ) : <>

      {/* ── Header card ─────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-control bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-elev-1">
                <CalendarIcon className="h-4 w-4 text-accent-fg stroke-[2.5]" aria-hidden="true" />
              </div>
              <h2 className="text-base font-bold text-fg tracking-tight">
                Daily Burning‑Activity Calendar
              </h2>
            </div>
            <p className="text-xs text-fg-muted max-w-2xl">
              1-km equal-area spatial-temporal harmonization with robust seasonal MAD baselines. Area:{' '}
              <span className="text-accent font-semibold">{area.name}</span>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
            {onSourceModeChange && (
              <div className="inline-flex flex-wrap max-w-full rounded-control border border-line bg-canvas p-0.5" role="group" aria-label="Data source mode">
                <button
                  type="button"
                  onClick={() => onSourceModeChange('live')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control text-xs font-semibold transition-colors ${
                    sourceMode === 'live'
                      ? 'bg-accent text-accent-fg shadow-elev-1'
                      : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                  Live (5-day NRT)
                </button>
                <button
                  type="button"
                  onClick={() => onSourceModeChange('historical')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control text-xs font-semibold transition-colors ${
                    sourceMode === 'historical'
                      ? 'bg-accent text-accent-fg shadow-elev-1'
                      : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  <Database className="h-3.5 w-3.5" aria-hidden="true" />
                  Historical Archive (2000–2025)
                </button>
              </div>
            )}
            <button
              onClick={downloadCalendarCsv}
              className="inline-flex items-center gap-2 min-h-touch px-4 rounded-control bg-accent hover:bg-accent-hover text-accent-fg font-semibold text-xs shadow-elev-1 transition-colors"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Export Calendar (CSV)
            </button>
          </div>
        </div>
      </div>

      {sourceMode === 'historical' ? (
        <>
          <SeasonalOutlookPanel />
          <HistoricalCalendar onInspectDate={onNavigateToMapWithDate} scope={scope} />
        </>
      ) : (
        <>
          {activeDaysCount === 0 && (
            <div className="bg-surface border border-accent/40 rounded-card p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-elev-1">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-control bg-accent/15 flex items-center justify-center shrink-0 mt-0.5">
                  <History className="h-5 w-5 text-accent" aria-hidden="true" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-fg">
                    No detections in the live 5-day NRT window for {area.name}
                  </h4>
                  <p className="text-xs text-fg-muted mt-0.5">
                    Live NRT only checks satellite observations from the last 5 days. For 25 years of multi-sensor satellite history (2000–2025) and seasonal patterns, open the Historical Archive.
                  </p>
                </div>
              </div>
              {onSourceModeChange && (
                <button
                  type="button"
                  onClick={() => onSourceModeChange('historical')}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-control bg-accent hover:bg-accent-hover text-accent-fg font-semibold text-xs shadow-elev-1 transition-colors shrink-0 cursor-pointer"
                >
                  <CalendarRange className="h-4 w-4" aria-hidden="true" />
                  View 25-Year Historical Archive
                </button>
              )}
            </div>
          )}
      {/* ── Stat cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="stat-card">
          <div className="flex items-center gap-2 mb-1">
            <Info className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
            <span className="text-fg-muted text-2xs font-medium uppercase tracking-wide">Days in range</span>
          </div>
          <div className="text-2xl font-bold text-fg numeric">{dailySummaries.length}</div>
          <div className="text-2xs text-fg-subtle mt-0.5">
            Calendar days up to today. A day without detections is not proof of no fire.
          </div>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 mb-1">
            <Flame className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            <span className="text-fg-muted text-2xs font-medium uppercase tracking-wide">Active fire days</span>
          </div>
          <div className="text-2xl font-bold text-accent numeric">{activeDaysCount}</div>
          <div className="text-2xs text-fg-subtle mt-0.5">
            With valid satellite hotspot detections
          </div>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-3.5 w-3.5 text-danger" aria-hidden="true" />
            <span className="text-fg-muted text-2xs font-medium uppercase tracking-wide">Unusual days</span>
          </div>
          <div className={`text-2xl font-bold numeric ${scoredDays === 0 ? 'text-fg-muted' : 'text-danger'}`}>
            {scoredDays === 0 ? '—' : anomalyDaysCount}
          </div>
          <div className="text-2xs text-fg-subtle mt-0.5">
            {scoredDays === 0
              ? 'A month needs 3+ other years in range'
              : 'Modified z ≥ 2.5 vs the same month in other years'}
          </div>
        </div>
      </div>

      {/* ── Year heatmap + month comparison ─────────────────────────────── */}
      <TimeseriesChart dailySummaries={dailySummaries} title="Daily calendar explorer" onInspectDate={onNavigateToMapWithDate} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2">
          <MonthYearHeatmap dailySummaries={dailySummaries} onSelectYear={setYear} />
        </div>
        <MonthComparisonCard dailySummaries={dailySummaries} />
      </div>

      {/* ── Interactive burning calendar ─────────────────────────────────── */}
      <BurningCalendar
        dailySummaries={dailySummaries}
        areaName={area.name}
        year={year}
        onInspectDateOnMap={onNavigateToMapWithDate}
      />
        </>
      )}
      </>}
    </div>
  );
};
