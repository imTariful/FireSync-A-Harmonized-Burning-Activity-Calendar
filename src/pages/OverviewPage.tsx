/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Flame,
  Layers,
  Calendar,
  BarChart3,
  Satellite,
  TrendingUp,
  Activity,
  Zap,
} from 'lucide-react';
import { DailyActivitySummary } from '../types/fire';
import type { Area } from '../utils/area';
import { TimeseriesChart } from '../components/charts/TimeseriesChart';
import { MonthComparisonCard } from '../components/calendar/MonthComparisonCard';
import { HistoricalArchivePanel } from '../components/overview/HistoricalArchivePanel';
import { ObservationFlowDiagram } from '../components/charts/ObservationFlowDiagram';

interface OverviewPageProps {
  dailySummaries: DailyActivitySummary[];
  area: Area;
  onNavigate: (tab: string) => void;
  kpis: {
    total_modis_detections: number;
    total_viirs_detections: number;
    total_raw_detections: number;
    active_spatial_temporal_bins: number;
    harmonized_activity_units: number;
    total_frp_mw: number;
    /** null = not computed. Never shown as a percentage. */
    data_coverage_completeness_pct: number | null;
    active_days?: number;
    most_recent_successful_ingestion: string | null;
  };
}

interface KpiProps {
  label: string;
  value: React.ReactNode;
  unit?: string;
  hint: string;
  icon?: React.ReactNode;
  accentColor?: string;
}

const Kpi: React.FC<KpiProps> = ({ label, value, unit, hint, icon, accentColor = 'text-accent' }) => (
  <div className="stat-card card-hover group">
    <div className="flex items-start justify-between mb-1">
      <span className="text-fg-muted text-2xs font-medium uppercase tracking-wide">{label}</span>
      {icon && <span className={`${accentColor} opacity-60 group-hover:opacity-100 transition-opacity`}>{icon}</span>}
    </div>
    <div className="flex items-baseline gap-1.5 my-1">
      <span className="text-2xl sm:text-3xl font-bold text-fg numeric">{value}</span>
      {unit && <span className="text-xs text-fg-muted numeric">{unit}</span>}
    </div>
    <span className="text-2xs text-fg-subtle">{hint}</span>
  </div>
);

const QuickAccessCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  primary?: boolean;
}> = ({ icon, title, description, onClick, primary = false }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full text-left rounded-card p-4 flex items-start gap-3 transition-all group border ${
      primary
        ? 'bg-accent hover:bg-accent-hover border-transparent text-accent-fg'
        : 'bg-surface hover:bg-raised border-line hover:border-line-strong'
    }`}
  >
    <span
      className={`mt-0.5 h-8 w-8 rounded-control flex items-center justify-center shrink-0 ${
        primary ? 'bg-black/10' : 'bg-raised group-hover:bg-overlay'
      }`}
    >
      {icon}
    </span>
    <div>
      <div className={`text-sm font-semibold ${primary ? 'text-accent-fg' : 'text-fg'}`}>{title}</div>
      <div className={`text-2xs mt-0.5 ${primary ? 'text-accent-fg/70' : 'text-fg-muted'}`}>{description}</div>
    </div>
    <ArrowRight className={`h-4 w-4 ml-auto mt-1 shrink-0 transition-transform group-hover:translate-x-0.5 ${primary ? 'text-accent-fg/70' : 'text-fg-muted'}`} aria-hidden="true" />
  </button>
);

export const OverviewPage: React.FC<OverviewPageProps> = ({ dailySummaries, area, onNavigate, kpis }) => {
  const anomalyDays = dailySummaries.filter(
    (d) => d.anomaly_category === 'high_anomaly' || d.anomaly_category === 'extreme_anomaly'
  );
  const scoredDays = dailySummaries.filter((d) => d.anomaly_category !== 'insufficient_data').length;
  const activeDays = kpis.active_days ?? dailySummaries.filter((d) => d.total_raw_detections > 0).length;

  return (
    <div className="space-y-6 page-enter">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="hero-gradient rounded-card border border-line p-6 sm:p-8 relative overflow-hidden">
        {/* Background fire icon watermark */}
        <div className="absolute right-6 top-1/2 -translate-y-1/2 opacity-[0.04] pointer-events-none select-none" aria-hidden="true">
          <Flame className="h-48 w-48" />
        </div>

        <div className="max-w-3xl space-y-3 relative">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge badge-amber">
              <Satellite className="h-3 w-3" aria-hidden="true" />
              NASA Space Apps Challenge 2026
            </span>
            <span className="text-2xs text-fg-subtle">BOT Battalion · Harmonization of MODIS and VIIRS Hot Spots</span>
          </div>

          <h1 className="text-2xl sm:text-4xl font-bold text-fg tracking-tight text-balance">
            FireSync: Harmonized Burning‑Activity Intelligence
          </h1>

          <p className="text-sm text-fg-muted max-w-2xl leading-relaxed">
            MODIS (1&thinsp;km) and VIIRS (375&thinsp;m) active‑fire detections are binned into 1‑km equal‑area
            cells and placed on one scale (BAU, 1‑km equivalent). The cross‑sensor calibration is{' '}
            <strong className="text-fg font-semibold">exploratory</strong>: the scale factor is a literature
            ratio, not fitted to data, and has not been validated. Selected area:{' '}
            <span className="text-accent font-semibold">{area.name}</span>.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => onNavigate('hotspots')}
              className="min-h-touch px-5 rounded-control bg-accent hover:bg-accent-hover text-accent-fg font-semibold text-sm inline-flex items-center gap-2 shadow-elev-1 transition-colors"
            >
              <Flame className="h-4 w-4" aria-hidden="true" />
              <span>Open the map</span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('calendar')}
              className="min-h-touch px-4 rounded-control bg-raised hover:bg-overlay text-fg font-medium text-sm border border-line transition-colors"
            >
              Burning calendar
            </button>
            <button
              type="button"
              onClick={() => onNavigate('methodology')}
              className="min-h-touch px-4 rounded-control border border-line-strong text-fg-muted hover:text-fg font-medium text-sm transition-colors"
            >
              Methodology
            </button>
          </div>
        </div>
      </section>

      {/* ── KPI Grid ─────────────────────────────────────────────────────── */}
      <section aria-label="Key figures" className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi
          label="Harmonized activity"
          value={kpis.harmonized_activity_units.toLocaleString()}
          unit="BAU"
          hint="1-km standard equivalent"
          icon={<Activity className="h-4 w-4" />}
        />
        <Kpi
          label="MODIS detections"
          value={kpis.total_modis_detections.toLocaleString()}
          hint="Terra and Aqua, 1 km"
          icon={<Satellite className="h-4 w-4" />}
          accentColor="text-orange-400"
        />
        <Kpi
          label="VIIRS detections"
          value={kpis.total_viirs_detections.toLocaleString()}
          hint="Suomi-NPP and NOAA-20, 375 m"
          icon={<Satellite className="h-4 w-4" />}
          accentColor="text-red-400"
        />
        <Kpi
          label="Active cells"
          value={kpis.active_spatial_temporal_bins.toLocaleString()}
          hint="1 km × 1 km equal-area cell-days"
          icon={<Layers className="h-4 w-4" />}
        />
        <Kpi
          label="Total FRP"
          value={kpis.total_frp_mw.toLocaleString()}
          unit="MW"
          hint="Both sensors, not de-duplicated"
          icon={<Zap className="h-4 w-4" />}
          accentColor="text-yellow-400"
        />
        <Kpi
          label="Days with detections"
          value={activeDays.toLocaleString()}
          hint="Within the selected range, up to today"
          icon={<Calendar className="h-4 w-4" />}
        />
      </section>

      {/* ── Local historical archive (2000–2025) ─────────────────────────── */}
      {/* ── Chart + Sidebar ──────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2">
          <TimeseriesChart
            dailySummaries={dailySummaries}
            title="Daily activity explorer"
          />
        </div>

        <div className="space-y-4">
          <MonthComparisonCard dailySummaries={dailySummaries} />

          {/* Anomaly panel */}
          <section
            aria-labelledby="anomaly-title"
            className="bg-surface border border-line rounded-card p-4 space-y-3"
          >
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
                <AlertTriangle className="h-4 w-4 text-accent" aria-hidden="true" />
              </div>
              <h3 id="anomaly-title" className="text-sm font-semibold text-fg">Unusual days</h3>
              {anomalyDays.length > 0 && (
                <span className="badge badge-danger ml-auto">{anomalyDays.length}</span>
              )}
            </div>

            {scoredDays === 0 ? (
              <p className="text-xs text-fg-muted">
                Not enough history for a seasonal baseline. Each month needs at least 3 other years of data in the
                selected range.
              </p>
            ) : anomalyDays.length === 0 ? (
              <p className="text-xs text-fg-muted">No high or extreme anomalies in the selected range.</p>
            ) : (
              <ul className="space-y-2">
                {anomalyDays.slice(0, 3).map((day) => (
                  <li
                    key={day.date}
                    className="bg-raised p-3 rounded-control text-xs flex items-center justify-between gap-3 border border-line"
                  >
                    <div>
                      <div className="numeric font-semibold text-fg">{day.date}</div>
                      <div className="text-2xs text-fg-muted">
                        {day.harmonized_activity_units} BAU · {day.total_raw_detections} hotspots
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="badge badge-danger text-2xs">
                        {day.anomaly_category.replace('_', ' ')}
                      </div>
                      <div className="text-2xs text-fg-muted numeric mt-0.5">z&thinsp;=&thinsp;{day.anomaly_score}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-2xs text-fg-subtle">
              Compared with the same month in other years. Statistical variation, not a fire forecast.
            </p>
          </section>
        </div>
      </section>

      <ObservationFlowDiagram />
      <HistoricalArchivePanel />

      {/* ── Quick-access cards ───────────────────────────────────────────── */}
      <section aria-label="Quick access" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <QuickAccessCard
          primary
          icon={<Flame className="h-4 w-4 text-accent-fg" aria-hidden="true" />}
          title="Hotspot Explorer"
          description="Interactive map, live & archive detections"
          onClick={() => onNavigate('hotspots')}
        />
        <QuickAccessCard
          icon={<Calendar className="h-4 w-4 text-accent" aria-hidden="true" />}
          title="Burning Calendar"
          description="Daily heatmap, year-over-year view"
          onClick={() => onNavigate('calendar')}
        />
        <QuickAccessCard
          icon={<BarChart3 className="h-4 w-4 text-accent" aria-hidden="true" />}
          title="Sensor Comparison"
          description="MODIS vs VIIRS calibration diagnostics"
          onClick={() => onNavigate('comparison')}
        />
        <QuickAccessCard
          icon={<TrendingUp className="h-4 w-4 text-accent" aria-hidden="true" />}
          title="Data & Exports"
          description="CSV downloads with provenance audit"
          onClick={() => onNavigate('exports')}
        />
      </section>

    </div>
  );
};
