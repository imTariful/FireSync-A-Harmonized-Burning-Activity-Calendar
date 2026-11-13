/**
 * CSV Generation utilities for FireSync data exports.
 * Implements strict formula-injection sanitization (sanitizing =, +, -, @ prefixes).
 */

import {
  CanonicalObservation,
  DailyActivitySummary,
  CalibrationModelMetrics,
  SpatialTemporalCell,
} from '../types/fire';
import type { MatchedPair } from './matching';

export type CsvMetadata = Record<string, unknown>;

/** Metadata is written as comment rows before the header. Values are sanitized like any cell. */
function metadataRows(metadata?: CsvMetadata): string[] {
  if (!metadata) return [];
  return [
    '# FireSync export metadata',
    ...Object.entries(metadata).map(([key, value]) => {
      // Strings are written as-is (then RFC 4180 escaped once); structured values are JSON encoded.
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return `# ${sanitizeCsvCell(key)},${sanitizeCsvCell(text)}`;
    }),
  ];
}

/**
 * Sanitizes a cell string to protect against CSV formula injection (CSV Injection / CWE-1236).
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  // Pure numbers are safe from formula execution
  if (typeof value === 'number') {
    return String(value);
  }
  let str = String(value);

  // If cell (trimmed or raw) starts with formula trigger characters, prepend single quote
  // Handles leading whitespace followed by =, +, -, @, \t, \r
  const trimmed = str.trimStart();
  if (/^[=+\-@\t\r]/.test(trimmed)) {
    const isPureNumber = trimmed !== '' && !isNaN(Number(trimmed)) && !trimmed.includes(' ');
    if (!isPureNumber || /^[=@\t\r]/.test(trimmed)) {
      str = `'${str}`;
    }
  }

  // Escape quotes according to RFC 4180
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Converts canonical observations into RFC 4180 compliant sanitized CSV format.
 */
export function observationsToCsv(
  observations: CanonicalObservation[],
  metadata?: CsvMetadata
): string {
  const headers = [
    'id',
    'source_record_id',
    'latitude',
    'longitude',
    'acq_date',
    'acq_time',
    'datetime_utc',
    'sensor',
    'satellite',
    'product',
    'processing_version',
    'confidence',
    'confidence_category',
    'frp_mw',
    'brightness',
    'bright_ti4',
    'bright_ti5',
    'scan',
    'track',
    'daynight',
    'source_file',
    'retrieved_at',
    'quality_flags',
    'record_hash',
  ];

  const rows = observations.map((obs) => [
    sanitizeCsvCell(obs.id),
    sanitizeCsvCell(obs.source_record_id),
    sanitizeCsvCell(obs.latitude),
    sanitizeCsvCell(obs.longitude),
    sanitizeCsvCell(obs.acq_date),
    sanitizeCsvCell(obs.acq_time),
    sanitizeCsvCell(obs.datetime_utc),
    sanitizeCsvCell(obs.sensor),
    sanitizeCsvCell(obs.satellite),
    sanitizeCsvCell(obs.product),
    sanitizeCsvCell(obs.processing_version),
    sanitizeCsvCell(obs.confidence),
    sanitizeCsvCell(obs.confidence_category),
    sanitizeCsvCell(obs.frp_mw),
    sanitizeCsvCell(obs.brightness ?? ''),
    sanitizeCsvCell(obs.bright_ti4 ?? ''),
    sanitizeCsvCell(obs.bright_ti5 ?? ''),
    sanitizeCsvCell(obs.scan),
    sanitizeCsvCell(obs.track),
    sanitizeCsvCell(obs.daynight),
    sanitizeCsvCell(obs.source_file),
    sanitizeCsvCell(obs.retrieved_at),
    sanitizeCsvCell(obs.quality_flags),
    sanitizeCsvCell(obs.record_hash),
  ]);

  return [...metadataRows(metadata), headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

/**
 * Converts daily calendar activity summaries into sanitized CSV format.
 */
export function calendarSummariesToCsv(
  summaries: DailyActivitySummary[],
  metadata?: CsvMetadata
): string {
  const headers = [
    'date',
    'year',
    'month',
    'day',
    'day_of_year',
    'modis_detections',
    'viirs_detections',
    'total_raw_detections',
    'harmonized_activity_units',
    'modis_frp_mw',
    'viirs_frp_mw',
    'total_frp_mw',
    'mean_frp_mw',
    'active_1km_cells',
    'historical_baseline_median',
    'historical_baseline_mad',
    'anomaly_score',
    'anomaly_category',
    'observation_coverage_pct',
    'data_quality',
  ];

  const rows = summaries.map((s) => [
    sanitizeCsvCell(s.date),
    sanitizeCsvCell(s.year),
    sanitizeCsvCell(s.month),
    sanitizeCsvCell(s.day),
    sanitizeCsvCell(s.day_of_year),
    sanitizeCsvCell(s.modis_detections),
    sanitizeCsvCell(s.viirs_detections),
    sanitizeCsvCell(s.total_raw_detections),
    sanitizeCsvCell(s.harmonized_activity_units),
    sanitizeCsvCell(s.modis_frp_mw),
    sanitizeCsvCell(s.viirs_frp_mw),
    sanitizeCsvCell(s.total_frp_mw),
    sanitizeCsvCell(s.mean_frp_mw),
    sanitizeCsvCell(s.active_1km_cells),
    sanitizeCsvCell(s.historical_baseline_median),
    sanitizeCsvCell(s.historical_baseline_mad),
    sanitizeCsvCell(s.anomaly_score),
    sanitizeCsvCell(s.anomaly_category),
    sanitizeCsvCell(s.observation_coverage_pct),
    sanitizeCsvCell(s.data_quality),
  ]);

  return [...metadataRows(metadata), headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

/**
 * Converts calibration metrics and validation results into sanitized CSV format.
 */
export function validationResultsToCsv(
  metrics: CalibrationModelMetrics,
  metadata?: CsvMetadata
): string {
  const headers = ['metric', 'value', 'description'];
  const rows = [
    ['model_id', sanitizeCsvCell(metrics.model_id), 'Identifier of the harmonization model'],
    ['model_version', sanitizeCsvCell(metrics.model_version), 'Semantic version of the calibration specification'],
    ['algorithm', sanitizeCsvCell(metrics.algorithm), 'Statistical model algorithm'],
    ['target_grid_km', sanitizeCsvCell(metrics.target_grid_km), 'Spatial resolution in kilometers'],
    ['sample_size_paired_cells', sanitizeCsvCell(metrics.sample_size_paired_cells), 'Paired MODIS-VIIRS observation cells'],
    ['training_period', sanitizeCsvCell(metrics.training_period), 'Holdout split: calibration period'],
    ['validation_period', sanitizeCsvCell(metrics.validation_period), 'Holdout split: evaluation period'],
    ['mae', sanitizeCsvCell(metrics.mae), 'Mean Absolute Error'],
    ['rmse', sanitizeCsvCell(metrics.rmse), 'Root Mean Squared Error'],
    ['mean_bias', sanitizeCsvCell(metrics.mean_bias), 'Mean prediction bias'],
    ['r_squared', sanitizeCsvCell(metrics.r_squared), 'Coefficient of determination (R2); empty when mathematically undefined'],
    ['calibration_slope', sanitizeCsvCell(metrics.calibration_slope), 'Calibration slope (fixed exploratory value unless a fit is explicitly reported)'],
    ['calibration_intercept', sanitizeCsvCell(metrics.calibration_intercept), 'Calibration intercept'],
    ['validation_status', sanitizeCsvCell(metrics.status), 'INSUFFICIENT / EXPLORATORY / CALIBRATED / VALIDATED'],
    ['independent_validation', sanitizeCsvCell(metrics.independent_validation ?? false), 'True only when a real holdout was evaluated'],
  ];

  return [...metadataRows(metadata), headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

/** Exploratory 1-km cell activity. Never label these rows validated. */
export function cellsToCsv(cells: SpatialTemporalCell[], metadata?: CsvMetadata): string {
  const headers = [
    'cell_id',
    'date',
    'grid_x',
    'grid_y',
    'center_lat',
    'center_lon',
    'modis_count',
    'viirs_count',
    'total_raw_count',
    'modis_frp_mw',
    'viirs_frp_mw',
    'total_frp_mw',
    'harmonized_activity_index',
    'harmonized_status',
    'dominant_sensor',
  ];
  const rows = cells.map((c) => [
    sanitizeCsvCell(c.cell_id),
    sanitizeCsvCell(c.date),
    sanitizeCsvCell(c.grid_x),
    sanitizeCsvCell(c.grid_y),
    sanitizeCsvCell(c.center_lat),
    sanitizeCsvCell(c.center_lon),
    sanitizeCsvCell(c.modis_count),
    sanitizeCsvCell(c.viirs_count),
    sanitizeCsvCell(c.total_raw_count),
    sanitizeCsvCell(c.modis_frp_sum),
    sanitizeCsvCell(c.viirs_frp_sum),
    sanitizeCsvCell(c.total_frp_sum),
    sanitizeCsvCell(c.harmonized_activity_index),
    sanitizeCsvCell('EXPLORATORY'),
    sanitizeCsvCell(c.dominant_sensor),
  ]);
  return [...metadataRows(metadata), headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

/** Matched MODIS–VIIRS pairs. Label is always EXPLORATORY. */
export function matchedPairsToCsv(pairs: MatchedPair[], metadata?: CsvMetadata): string {
  const headers = [
    'matching_status',
    'date',
    'modis_id',
    'viirs_id',
    'distance_km',
    'time_diff_minutes',
    'modis_frp_mw',
    'viirs_frp_mw',
    'modis_satellite',
    'viirs_satellite',
  ];
  const rows = pairs.map((p) => [
    sanitizeCsvCell('EXPLORATORY'),
    sanitizeCsvCell(p.modis.acq_date),
    sanitizeCsvCell(p.modis.id),
    sanitizeCsvCell(p.viirs.id),
    sanitizeCsvCell(Number(p.distanceKm.toFixed(3))),
    sanitizeCsvCell(Number(p.timeDiffMinutes.toFixed(1))),
    sanitizeCsvCell(p.modis.frp_mw),
    sanitizeCsvCell(p.viirs.frp_mw),
    sanitizeCsvCell(p.modis.satellite),
    sanitizeCsvCell(p.viirs.satellite),
  ]);
  return [...metadataRows(metadata), headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}
