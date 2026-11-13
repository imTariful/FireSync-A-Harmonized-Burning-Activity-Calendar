/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SensorDot } from '../components/SensorDot';
import React, { useEffect, useState } from 'react';
import { BarChart3, Satellite, Info, BookOpen } from 'lucide-react';
import { CalibrationModelMetrics } from '../types/fire';
import type { AreaScope } from '../utils/area';
import { CalibrationDiagnosticChart } from '../components/charts/CalibrationDiagnosticChart';
import { HistoricalOverlapTable } from '../components/comparison/HistoricalOverlapTable';
import { api, liveObservationQuery, type LiveFilters, type SensorComparisonResponse } from '../api/client';
import { SensorVisualDashboard } from '../components/comparison/SensorVisualDashboard';

interface SensorComparisonPageProps {
  /** The area (bbox) the numbers belong to. */
  scope: AreaScope;
  filters: LiveFilters;
  calibrationMetrics: CalibrationModelMetrics;
}

interface SpecRowProps {
  label: string;
  value: React.ReactNode;
}

const SpecRow: React.FC<SpecRowProps> = ({ label, value }) => (
  <div className="bg-canvas rounded-control border border-line p-3">
    <div className="text-fg-subtle text-2xs font-mono uppercase tracking-wider mb-0.5">{label}</div>
    <div className="text-fg text-xs font-medium">{value}</div>
  </div>
);

export const SensorComparisonPage: React.FC<SensorComparisonPageProps> = ({
  scope,
  filters,
  calibrationMetrics,
}) => {
  const [comparisonData, setComparisonData] = useState<SensorComparisonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Same live source, area, sensor filter and (clamped) date range as the rest of the app: the numbers below
  // must match what the Sensor dropdown says and what the other pages show.
  useEffect(() => {
    let cancelled = false;
    setComparisonData(null);
    setLoading(true);
    setError(null);
    api
      .getSensorComparison(liveObservationQuery(filters, scope))
      .then((data) => {
        if (!cancelled) setComparisonData(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Sensor comparison unavailable.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [scope.bbox, scope.aoi, scope.sensors, filters.startDate, filters.endDate, filters.satellite, filters.minConfidence, filters.minFRP]);

  return (
    <div className="space-y-6 page-enter">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded-control bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-elev-1 shrink-0">
            <BarChart3 className="h-4 w-4 text-accent-fg stroke-[2.5]" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-bold text-fg tracking-tight">
              Sensor Comparison &amp; Cross-Platform Calibration
            </h2>
            <p className="text-xs text-fg-muted mt-0.5">
              Physics-based and statistical harmonization between MODIS 1-km and VIIRS 375-m active fire observations
            </p>
          </div>
        </div>
      </div>

      <SensorVisualDashboard data={comparisonData} loading={loading} error={error} />

      {/* ── Side-by-side Sensor Cards ───────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* MODIS Card */}
        <div className="bg-surface border border-line hover:border-orange-500/40 rounded-card p-5 space-y-4 transition-all card-hover shadow-elev-1">
          <div className="flex items-start justify-between border-b border-line pb-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs">
                <SensorDot sensor="MODIS" />
                <span className="font-mono font-bold text-fg uppercase tracking-wider">MODIS</span>
                <span className="text-fg-subtle">·</span>
                <span className="font-mono text-fg-muted text-2xs">1000 m (Nadir)</span>
              </div>
              <h3 className="font-semibold text-fg text-sm">
                Moderate Resolution Imaging Spectroradiometer
              </h3>
            </div>
            <span className="badge badge-amber text-2xs shrink-0">Terra &amp; Aqua</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <SpecRow label="Nadir Resolution" value="1.0 km (1000 m)" />
            <SpecRow label="Scan Edge Footprint" value="2.0 km × 4.8 km" />
            <SpecRow label="Spectral Channels" value="B21/22 (3.9 μm), B31 (11 μm)" />
            <SpecRow
              label="Equatorial Crossing"
              value="Overpass times differ between satellites; see Harmonize panel."
            />
          </div>

          <div className="bg-canvas border border-line rounded-control p-3.5 text-xs text-fg-muted leading-relaxed space-y-1">
            <div className="font-mono text-fg-subtle text-2xs uppercase tracking-wider font-semibold mb-1.5">
              Detection Characteristics
            </div>
            <p>
              High saturation ceiling (~500 K) reduces likelihood of sensor saturation in intense fires.
              However, due to the 1-km footprint and off-nadir bow-tie pixel expansion, MODIS
              underdetects small, low-intensity agricultural residue burns below 10–20 MW.
            </p>
          </div>
        </div>

        {/* VIIRS Card */}
        <div className="bg-surface border border-line hover:border-red-500/40 rounded-card p-5 space-y-4 transition-all card-hover shadow-elev-1">
          <div className="flex items-start justify-between border-b border-line pb-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs">
                <SensorDot sensor="VIIRS" />
                <span className="font-mono font-bold text-fg uppercase tracking-wider">VIIRS</span>
                <span className="text-fg-subtle">·</span>
                <span className="font-mono text-fg-muted text-2xs">375 m (Nadir)</span>
              </div>
              <h3 className="font-semibold text-fg text-sm">
                Visible Infrared Imaging Radiometer Suite
              </h3>
            </div>
            <span className="badge badge-info text-2xs shrink-0">NOAA-20 &amp; NOAA-21</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <SpecRow label="Nadir Resolution" value="375 m (I-Bands)" />
            <SpecRow label="Scan Edge Footprint" value="~800 m (Pixel Aggregated)" />
            <SpecRow label="Spectral Channels" value="I4 (3.74 μm), I5 (11.45 μm)" />
            <SpecRow
              label="Equatorial Crossing"
              value="Overpass times differ between satellites; see Harmonize panel."
            />
          </div>

          <div className="bg-canvas border border-line rounded-control p-3.5 text-xs text-fg-muted leading-relaxed space-y-1">
            <div className="font-mono text-fg-subtle text-2xs uppercase tracking-wider font-semibold mb-1.5">
              Detection Characteristics
            </div>
            <p>
              Onboard sample aggregation trims bow-tie overlap, maintaining near-constant resolution.
              The 375 m I-bands resolve sub-kilometer fire perimeters and detect fires down to ~3–5 MW,
              yielding more detections than MODIS in most conditions.
            </p>
          </div>
        </div>
      </div>

      {/* ── Loaded detections: what the Sensor filter above is doing ─────── */}
      {comparisonData && (
        <div className="bg-surface border border-line rounded-card p-5 space-y-3">
          <h3 className="text-sm font-bold text-fg">Loaded detections for the selected area and window</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {[
              { label: 'MODIS detections', value: comparisonData.comparison.modis_total_detections.toLocaleString() },
              { label: 'VIIRS detections', value: comparisonData.comparison.viirs_total_detections.toLocaleString() },
              {
                label: 'VIIRS : MODIS ratio',
                value: comparisonData.comparison.ratio_viirs_to_modis ?? '—',
              },
              {
                label: 'Paired 1-km cells',
                value: comparisonData.comparison.paired_1km_cells_count.toLocaleString(),
              },
            ].map((s) => (
              <div key={s.label} className="bg-canvas border border-line rounded-control p-3">
                <div className="text-fg-subtle text-2xs font-mono uppercase tracking-wider">{s.label}</div>
                <div className="text-xl font-bold font-mono numeric mt-0.5 text-fg">{s.value}</div>
              </div>
            ))}
          </div>
          <p className="text-2xs text-fg-subtle">
            Counts come from the live NASA FIRMS window for the selected area, sensor and dates above. MODIS and
            VIIRS stay separate; they are never summed.
          </p>
        </div>
      )}

      {/* ── Core challenge callout ───────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 space-y-2">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
            <Info className="h-4 w-4 text-accent" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-bold text-fg">
            The Core Remote-Sensing Challenge: Hotspots ≠ Fires
          </h3>
        </div>
        <p className="text-xs text-fg-muted leading-relaxed ml-9">
          In Earth-observation literature, an active-fire hotspot is a satellite observation flag,
          not a unique fire incident or a measurement of burned area. When a fire is viewed by
          both MODIS and VIIRS, VIIRS may register four separate 375-m pixels for the same burning front
          that MODIS detects as a single 1-km pixel. Summing raw MODIS and VIIRS detections creates
          double-counting and inflates trends. FireSync harmonizes these into common 1-km equal-area
          spatial-temporal bins with calibrated activity weights.
        </p>
      </div>

      {/* ── Calibration Diagnostics ──────────────────────────────────────── */}
      {/* pairedPoints come from the same scoped comparison request, not the global store */}
      <CalibrationDiagnosticChart
        metrics={comparisonData?.comparison.calibration_metrics ?? calibrationMetrics}
        pairedPoints={
          Array.isArray(comparisonData?.comparison?.paired_cells) &&
          comparisonData.comparison.paired_cells.length > 0
            ? comparisonData.comparison.paired_cells.map(
                (c) => ({
                  modis: c.modis_count,
                  viirs: c.viirs_count,
                  date: c.date,
                  cell_id: c.cell_id,
                })
              )
            : undefined
        }
      />

      {/* ── Historical archive overlap (2012–2025, S-NPP VIIRS only) ──────── */}
      <HistoricalOverlapTable />
    </div>
  );
};
