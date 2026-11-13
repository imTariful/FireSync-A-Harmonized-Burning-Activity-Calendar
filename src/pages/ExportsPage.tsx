/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Download, FileText, ShieldCheck, Database, Calendar, CheckCircle2, AlertCircle } from 'lucide-react';
import { FilterState, IngestionJob } from '../types/fire';
import type { Area, AreaScope } from '../utils/area';
import { AreaEmptyState } from '../components/area/AreaChip';
import { api, liveObservationQuery } from '../api/client';
import { NASA_DATASET_METADATA } from '../data/nasa_products';
import { HistoricalExports } from '../components/exports/HistoricalExports';

interface ExportsPageProps {
  filters: FilterState;
  /** The area (bbox) and sensor on screen: every area-scoped CSV below uses exactly this, so a download matches the page. */
  scope: AreaScope;
  area: Area;
  observationCount: number;
  /** The date range the page is actually serving (clamped to the live window when the filters reach past it). */
  displayRange?: { start: string; end: string };
  /** The loaded data has no rows for the area: the area-scoped exports are replaced by an explanation. */
  noArchive?: boolean;
  onChangeAreaOnMap?: () => void;
}

interface ExportCardProps {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
  meta: React.ReactNode;
  buttonLabel: string;
  buttonClass: string;
  onDownload: () => void;
}

const ExportCard: React.FC<ExportCardProps> = ({
  icon, iconBg, title, description, meta, buttonLabel, buttonClass, onDownload,
}) => (
  <div className="bg-surface border border-line rounded-card p-5 flex flex-col gap-4 card-hover shadow-elev-1">
    <div className="space-y-2">
      <div className="flex items-center gap-2.5">
        <div className={`h-8 w-8 rounded-control flex items-center justify-center shrink-0 ${iconBg}`}>
          {icon}
        </div>
        <h3 className="font-bold text-fg text-sm">{title}</h3>
      </div>
      <p className="text-xs text-fg-muted leading-relaxed">{description}</p>
      <div className="bg-raised border border-line rounded-control p-2.5 text-2xs text-fg-muted font-mono">
        {meta}
      </div>
    </div>
    <button
      onClick={onDownload}
      className={`w-full inline-flex items-center justify-center gap-2 min-h-touch rounded-control font-bold text-xs transition shadow-elev-1 ${buttonClass}`}
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      {buttonLabel}
    </button>
  </div>
);

export const ExportsPage: React.FC<ExportsPageProps> = ({
  filters,
  scope,
  area,
  observationCount,
  displayRange,
  noArchive = false,
  onChangeAreaOnMap,
}) => {
  const [jobs, setJobs] = useState<IngestionJob[]>([]);

  useEffect(() => {
    api.getIngestionJobs().then((res) => {
      setJobs(res.jobs || []);
    });
  }, []);

  const handleDownload = (endpoint: string) => {
    window.location.href = endpoint;
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto page-enter">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded-control bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-elev-1 shrink-0">
            <Download className="h-4 w-4 text-accent-fg stroke-[2.5]" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-bold text-fg tracking-tight">Data Center &amp; Verified CSV Exports</h2>
            <p className="text-xs text-fg-muted mt-0.5">
              Download standardized datasets, burning calendars, and calibration reports with formula-injection sanitization
            </p>
          </div>
        </div>
      </div>

      {/* ── Export Cards ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {noArchive ? (
          <div className="md:col-span-2">
            <AreaEmptyState onChange={onChangeAreaOnMap} />
          </div>
        ) : (
          <>
            <ExportCard
              icon={<FileText className="h-4 w-4 text-accent-fg" aria-hidden="true" />}
              iconBg="bg-gradient-to-br from-amber-500 to-orange-500"
              title="Filtered Hotspots (CSV)"
              description={`Canonical NASA FIRMS observations matching the current filters in ${area.name}. Includes FRP, coordinates, confidence, scan/track, and source file hash.`}
              meta={
                <>Records: <span className="text-accent font-bold">{observationCount.toLocaleString()}</span> observations</>
              }
              buttonLabel="Download Hotspots CSV"
              buttonClass="bg-accent hover:bg-accent-hover text-accent-fg"
              onDownload={() =>
                handleDownload(
                  api.getExportCsvUrl(liveObservationQuery(filters, scope))
                )
              }
            />

            <ExportCard
              icon={<Calendar className="h-4 w-4 text-info" aria-hidden="true" />}
              iconBg="bg-raised border border-line"
              title="Burning Calendar (CSV)"
              description={`Daily time series of harmonized burning activity units (BAU) for ${area.name}, historical seasonal baselines (median & MAD), and robust Z-score anomaly classifications.`}
              meta={
                <>
                  Range: <span className="text-info">{displayRange?.start ?? filters.startDate}</span> to{' '}
                  <span className="text-info">{displayRange?.end ?? filters.endDate}</span>
                </>
              }
              buttonLabel="Download Calendar CSV"
              buttonClass="bg-info hover:bg-blue-400 text-canvas"
              onDownload={() =>
                handleDownload(
                  api.getExportCalendarCsvUrl(liveObservationQuery(filters, scope))
                )
              }
            />
          </>
        )}

        <ExportCard
          icon={<ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" />}
          iconBg="bg-raised border border-line"
          title="Calibration Diagnostics (CSV)"
          description="In-sample fixed-coefficient calibration metrics: Mean Absolute Error (MAE), Root Mean Squared Error (RMSE), Mean Bias, and exploratory scale factor."
          meta={<>Spec: <span className="text-amber-500">Exploratory Fixed-Scale (slope 0.294)</span></>}
          buttonLabel="Download Calibration CSV"
          buttonClass="bg-accent hover:bg-accent-hover text-accent-fg"
          onDownload={() =>
            handleDownload(
              api.getExportValidationCsvUrl(liveObservationQuery(filters, scope))
            )
          }
        />
      </div>

      {/* ── Historical archive exports ──────────────────────────────────── */}
      <HistoricalExports />

      {/* ── Security Banner ─────────────────────────────────────────────── */}
      <div className="bg-surface border border-success/20 rounded-card p-4 flex items-start gap-3">
        <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
          <ShieldCheck className="h-4 w-4 text-success" aria-hidden="true" />
        </div>
        <div>
          <div className="text-sm font-semibold text-fg">Formula-Injection Protection (CWE-1236 Compliant)</div>
          <p className="text-xs text-fg-muted leading-relaxed mt-0.5">
            All CSV exports are sanitized against formula injection. Cells starting with dangerous formula characters
            (=, +, -, @) are automatically single-quote escaped to prevent arbitrary command execution in spreadsheet software.
          </p>
        </div>
      </div>

      {/* ── Dataset Lineage Table ───────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 space-y-4 shadow-elev-1">
        <div className="flex items-center gap-2 border-b border-line pb-3">
          <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
            <Database className="h-4 w-4 text-info" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-bold text-fg">Dataset Lineage &amp; Ingestion Audit</h3>
        </div>

        <div className="overflow-x-auto scrollbar-none">
          <table className="w-full text-left text-xs text-fg-muted font-mono">
            <thead className="border-b border-line text-fg-subtle text-2xs uppercase tracking-wide font-sans">
              <tr>
                <th className="py-2.5 px-3 font-medium">Job ID</th>
                <th className="py-2.5 px-3 font-medium">Sensor / Satellite</th>
                <th className="py-2.5 px-3 font-medium">Scope</th>
                <th className="py-2.5 px-3 font-medium">Records</th>
                <th className="py-2.5 px-3 font-medium">Checksum</th>
                <th className="py-2.5 px-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-fg-subtle">
                    No ingestion jobs recorded yet.
                  </td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-raised transition-colors">
                    <td className="py-3 px-3 text-accent font-medium">{job.id}</td>
                    <td className="py-3 px-3 text-fg font-sans">
                      {job.sensor} ({job.satellite})
                    </td>
                    <td className="py-3 px-3 text-fg-muted font-sans">{job.region}</td>
                    <td className="py-3 px-3 text-fg font-bold numeric">{(job.records_imported ?? 0).toLocaleString()}</td>
                    <td className="py-3 px-3 text-fg-subtle text-2xs truncate max-w-xs">
                      {job.checksum}
                    </td>
                    <td className="py-3 px-3 font-sans">
                      <span className="badge badge-success text-2xs uppercase">
                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                        {job.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
