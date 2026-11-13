/**
 * Paired MODIS-VIIRS Observation Analysis for FireSync
 *
 * This script analyzes the spatial-temporal characteristics of concurrent
 * MODIS and VIIRS observations to build defensible calibration pairs.
 *
 * Distinguishes between:
 * - Detection-level observations (individual hotspot points)
 * - Aggregated sensor-specific activity measures (counts per cell)
 * - Spatial-temporal comparison pairs (cells with both sensors on same day)
 * - Calibration targets (reference values to predict)
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadObservationsOrExit } from './lib/load_observations';
import { aggregateToSpatialTemporalGrid } from '../src/utils/harmonization';
import { haversineDistanceKm } from '../src/utils/spatial';
import { CanonicalObservation, SpatialTemporalCell } from '../src/types/fire';

interface DetectionLevelStats {
  total_detections: number;
  by_sensor: { MODIS: number; VIIRS: number };
  by_satellite: Record<string, number>;
  by_confidence: Record<string, number>;
  by_daynight: Record<string, number>;
  frp_range: { min: number; max: number; mean: number };
}

interface CellPairAnalysis {
  cell_id: string;
  date: string;
  center_lat: number;
  center_lon: number;
  modis_count: number;
  viirs_count: number;
  viirs_satellites: string[];
  modis_satellites: string[];
  /** Smallest observed MODIS-VIIRS time difference in the cell; null when no usable time is present. */
  time_between_observations_minutes: number | null;
  frp_total_mw: number;
  detection_density_per_km2: number;
  spatial_extent_km: number;
}

interface PairedSampleReport {
  metadata: {
    generated_at: string;
    input_path: string;
    provenance_status: 'VERIFIED' | 'UNVERIFIED';
    total_observations: number;
    temporal_span_days: number;
    geographic_bbox: { west: number; south: number; east: number; north: number };
  };
  detection_level_analysis: DetectionLevelStats;
  spatial_temporal_cells: {
    total_cells: number;
    modis_only_cells: number;
    viirs_only_cells: number;
    concurrent_paired_cells: number;
  };
  paired_cells_analysis: CellPairAnalysis[];
  sensor_comparison: {
    modis_total_detections: number;
    viirs_total_detections: number;
    viirs_to_modis_ratio: number;
    detection_efficiency_by_satellite: Record<string, { modis: number; viirs: number }>;
  };
  temporal_coverage: {
    distinct_dates: number;
    dates_with_both_sensors: number;
    dates_with_modis_only: number;
    dates_with_viirs_only: number;
    date_distribution: string[];
  };
  calibration_readiness: {
    paired_cell_count: number;
    distinct_dates_in_pairs: number;
    geographic_diversity: number;
    reference_variance: number;
    readiness_status: 'insufficient' | 'exploratory' | 'ready_for_validation';
    gaps_identified: string[];
  };
}

function computeDetectionLevelStats(observations: CanonicalObservation[]): DetectionLevelStats {
  const stats: DetectionLevelStats = {
    total_detections: observations.length,
    by_sensor: { MODIS: 0, VIIRS: 0 },
    by_satellite: {},
    by_confidence: {},
    by_daynight: {},
    frp_range: { min: Infinity, max: -Infinity, mean: 0 },
  };

  let frpSum = 0;

  for (const obs of observations) {
    stats.by_sensor[obs.sensor]++;
    stats.by_satellite[obs.satellite] = (stats.by_satellite[obs.satellite] || 0) + 1;
    stats.by_confidence[obs.confidence_category] = (stats.by_confidence[obs.confidence_category] || 0) + 1;
    stats.by_daynight[obs.daynight] = (stats.by_daynight[obs.daynight] || 0) + 1;

    stats.frp_range.min = Math.min(stats.frp_range.min, obs.frp_mw);
    stats.frp_range.max = Math.max(stats.frp_range.max, obs.frp_mw);
    frpSum += obs.frp_mw;
  }

  stats.frp_range.mean = observations.length > 0 ? frpSum / observations.length : 0;
  stats.frp_range.min = stats.frp_range.min === Infinity ? 0 : stats.frp_range.min;
  stats.frp_range.max = stats.frp_range.max === -Infinity ? 0 : stats.frp_range.max;

  return stats;
}

/** Minutes after UTC midnight from datetime_utc, falling back to acq_time (HHMM). */
function minutesOfDay(o: CanonicalObservation): number | null {
  if (o.datetime_utc) {
    const ms = Date.parse(o.datetime_utc);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    }
  }
  const raw = (o.acq_time ?? '').padStart(4, '0');
  if (!/^\d{4}$/.test(raw)) return null;
  const h = Number(raw.slice(0, 2));
  const m = Number(raw.slice(2));
  return h < 24 && m < 60 ? h * 60 + m : null;
}

function analyzePairedCells(
  pairedCells: SpatialTemporalCell[],
  observations: CanonicalObservation[]
): CellPairAnalysis[] {
  const analyses: CellPairAnalysis[] = [];

  for (const cell of pairedCells) {
    // Extract satellites contributing to this cell
    const cellObservations = observations.filter(
      (o) => o.acq_date === cell.date &&
        Math.abs(o.latitude - cell.center_lat) < 0.01 &&
        Math.abs(o.longitude - cell.center_lon) < 0.01
    );

    const modisSats = new Set(
      cellObservations.filter((o) => o.sensor === 'MODIS').map((o) => o.satellite)
    );
    const viirsSats = new Set(
      cellObservations.filter((o) => o.sensor === 'VIIRS').map((o) => o.satellite)
    );

    // Smallest observed MODIS-VIIRS time difference within this cell-day. No value is invented:
    // when either side has no usable acquisition time, the field is null.
    const modisTimes = cellObservations
      .filter((o) => o.sensor === 'MODIS')
      .map(minutesOfDay)
      .filter((m): m is number => m !== null);
    const viirsTimes = cellObservations
      .filter((o) => o.sensor === 'VIIRS')
      .map(minutesOfDay)
      .filter((m): m is number => m !== null);
    const timeBetweenMinutes =
      modisTimes.length > 0 && viirsTimes.length > 0
        ? Math.min(
            ...modisTimes.flatMap((m) => viirsTimes.map((v) => Math.abs(v - m)))
          )
        : null;

    // Detection density (detections per km² within the 1-km cell)
    const detectionDensity = cell.total_raw_count / 1.0;

    analyses.push({
      cell_id: cell.cell_id,
      date: cell.date,
      center_lat: cell.center_lat,
      center_lon: cell.center_lon,
      modis_count: cell.modis_count,
      viirs_count: cell.viirs_count,
      viirs_satellites: Array.from(viirsSats),
      modis_satellites: Array.from(modisSats),
      time_between_observations_minutes: timeBetweenMinutes,
      frp_total_mw: cell.total_frp_sum,
      detection_density_per_km2: detectionDensity,
      spatial_extent_km: 1.0, // 1-km grid
    });
  }

  return analyses;
}

function computeGeographicDiversity(pairedCells: SpatialTemporalCell[]): number {
  // Count distinct geographic clusters (cells within 10 km of each other)
  if (pairedCells.length === 0) return 0;

  const clusters: number[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < pairedCells.length; i++) {
    if (used.has(i)) continue;

    const cluster = [i];
    used.add(i);

    for (let j = i + 1; j < pairedCells.length; j++) {
      if (used.has(j)) continue;

      const distKm = haversineDistanceKm(
        pairedCells[i].center_lat,
        pairedCells[i].center_lon,
        pairedCells[j].center_lat,
        pairedCells[j].center_lon
      );

      if (distKm < 10) {
        cluster.push(j);
        used.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters.length;
}

function main() {
  console.log('[FireSync] Analyzing paired MODIS-VIIRS observations...');
  const input = loadObservationsOrExit('analyze_paired_observations');
  const observations = input.observations;
  console.log(
    `[FireSync] Input: ${input.path} (${observations.length} observations, provenance ${input.provenance_status})`
  );

  // Detection-level analysis
  const detectionStats = computeDetectionLevelStats(observations);

  // Spatial-temporal cell aggregation
  const cellMap = aggregateToSpatialTemporalGrid(observations, 1.0);
  const allCells = Array.from(cellMap.values());

  const modisOnlyCells = allCells.filter((c) => c.modis_count > 0 && c.viirs_count === 0);
  const viirsOnlyCells = allCells.filter((c) => c.viirs_count > 0 && c.modis_count === 0);
  const pairedCells = allCells.filter((c) => c.modis_count > 0 && c.viirs_count > 0);

  // Paired cell analysis
  const pairedAnalysis = analyzePairedCells(pairedCells, observations);

  // Sensor comparison
  const modisTotal = observations.filter((o) => o.sensor === 'MODIS').length;
  const viirsTotal = observations.filter((o) => o.sensor === 'VIIRS').length;

  const detectionEfficiency: Record<string, { modis: number; viirs: number }> = {};
  const satellites = new Set(observations.map((o) => o.satellite));
  for (const sat of satellites) {
    const satObs = observations.filter((o) => o.satellite === sat);
    detectionEfficiency[sat] = {
      modis: satObs.filter((o) => o.sensor === 'MODIS').length,
      viirs: satObs.filter((o) => o.sensor === 'VIIRS').length,
    };
  }

  // Temporal coverage
  const distinctDates = new Set(observations.map((o) => o.acq_date));
  const datesWithBoth = new Set(
    pairedCells.map((c) => c.date)
  );
  const datesWithModisOnly = new Set(
    modisOnlyCells.map((c) => c.date)
  );
  const datesWithViirsOnly = new Set(
    viirsOnlyCells.map((c) => c.date)
  );

  // Calibration readiness assessment
  const modisCountsInPairs = pairedCells.map((c) => c.modis_count);
  const modisVariance =
    modisCountsInPairs.length > 0
      ? modisCountsInPairs.reduce((sum, x) => sum + Math.pow(x - modisCountsInPairs.reduce((a, b) => a + b, 0) / modisCountsInPairs.length, 2), 0) / modisCountsInPairs.length
      : 0;

  const geographicDiversity = computeGeographicDiversity(pairedCells);

  const gaps: string[] = [];
  if (pairedCells.length < 50) gaps.push(`Insufficient paired cells: ${pairedCells.length} < 50 threshold`);
  if (modisVariance === 0) gaps.push('Zero reference variance (uniform MODIS counts prevents R² calculation)');
  if (geographicDiversity < 5) gaps.push(`Low geographic diversity: ${geographicDiversity} clusters < 5`);
  if (datesWithBoth.size < 20) gaps.push(`Limited temporal diversity: ${datesWithBoth.size} dates < 20`);

  const readinessStatus: 'insufficient' | 'exploratory' | 'ready_for_validation' =
    pairedCells.length >= 50 && modisVariance > 0 && geographicDiversity >= 5 && datesWithBoth.size >= 20
      ? 'ready_for_validation'
      : pairedCells.length >= 10
      ? 'exploratory'
      : 'insufficient';

  const report: PairedSampleReport = {
    metadata: {
      generated_at: new Date().toISOString(),
      input_path: input.path,
      provenance_status: input.provenance_status,
      total_observations: observations.length,
      temporal_span_days: distinctDates.size,
      geographic_bbox: {
        west: Math.min(...observations.map((o) => o.longitude)),
        south: Math.min(...observations.map((o) => o.latitude)),
        east: Math.max(...observations.map((o) => o.longitude)),
        north: Math.max(...observations.map((o) => o.latitude)),
      },
    },
    detection_level_analysis: detectionStats,
    spatial_temporal_cells: {
      total_cells: allCells.length,
      modis_only_cells: modisOnlyCells.length,
      viirs_only_cells: viirsOnlyCells.length,
      concurrent_paired_cells: pairedCells.length,
    },
    paired_cells_analysis: pairedAnalysis,
    sensor_comparison: {
      modis_total_detections: modisTotal,
      viirs_total_detections: viirsTotal,
      viirs_to_modis_ratio: modisTotal > 0 ? Number((viirsTotal / modisTotal).toFixed(2)) : 0,
      detection_efficiency_by_satellite: detectionEfficiency,
    },
    temporal_coverage: {
      distinct_dates: distinctDates.size,
      dates_with_both_sensors: datesWithBoth.size,
      dates_with_modis_only: datesWithModisOnly.size,
      dates_with_viirs_only: datesWithViirsOnly.size,
      date_distribution: Array.from(distinctDates).sort(),
    },
    calibration_readiness: {
      paired_cell_count: pairedCells.length,
      distinct_dates_in_pairs: datesWithBoth.size,
      geographic_diversity: geographicDiversity,
      reference_variance: Number(modisVariance.toFixed(4)),
      readiness_status: readinessStatus,
      gaps_identified: gaps,
    },
  };

  // Save report
  const reportsDir = path.resolve(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const reportPath = path.join(reportsDir, 'paired_observations_analysis.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('[FireSync] Paired observations analysis complete.');
  console.log(`  -> Report saved to: ${reportPath}`);
  console.log(`  -> Paired cells: ${pairedCells.length}`);
  console.log(`  -> Readiness status: ${readinessStatus.toUpperCase()}`);
  console.log(`  -> Gaps: ${gaps.length}`);
}

main();
