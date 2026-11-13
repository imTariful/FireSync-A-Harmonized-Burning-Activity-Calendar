/**
 * Canonical observation schema and domain types for NASA MODIS–VIIRS FireSync platform.
 */

export type SensorType = 'MODIS' | 'VIIRS';
export type SatelliteType = 'Terra' | 'Aqua' | 'Suomi-NPP' | 'NOAA-20' | 'NOAA-21';
export type DayNightType = 'D' | 'N' | 'UNKNOWN';
export type ConfidenceCategory = 'low' | 'nominal' | 'high';

/** Provenance of a dataset. A SHA-256 checksum proves file integrity, not NASA authenticity. */
export type ProvenanceStatus = 'VERIFIED' | 'UNVERIFIED';

/** Scientific status of a calibration. VALIDATED requires independent holdout evidence. */
export type CalibrationStatus = 'EXPLORATORY' | 'INSUFFICIENT' | 'CALIBRATED' | 'VALIDATED';

/** Whether a calendar day has an observation, no observation, or unknown coverage. */
export type CoverageStatus = 'observed' | 'no_observation' | 'unknown' | 'incomplete_archive';

/** A polygon AOI in [lon, lat] order (GeoJSON convention). */
export type AoiPolygon = [number, number][];

export interface CanonicalObservation {
  id: string;
  source_record_id: string;
  latitude: number;
  longitude: number;
  acq_date: string; // YYYY-MM-DD
  acq_time: string; // HHMM
  datetime_utc: string; // ISO 8601
  sensor: SensorType;
  satellite: SatelliteType;
  product: string; // e.g. 'MODIS_C6_1', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT'
  processing_version: string; // e.g. '6.1', '2.0NRT'
  confidence: number | string; // 0-100 for MODIS, 'low'|'nominal'|'high' or 0-100 for VIIRS
  confidence_category: ConfidenceCategory;
  frp_mw: number; // Fire Radiative Power in Megawatts
  brightness?: number; // Kelvin
  bright_ti4?: number; // VIIRS 375m I4 (3.74 um) brightness temp in K
  bright_ti5?: number; // VIIRS 375m I5 (11.45 um) brightness temp in K
  scan: number; // along-scan pixel dimension (km)
  track: number; // along-track pixel dimension (km)
  daynight: DayNightType;
  source_file: string;
  retrieved_at: string;
  quality_flags: string;
  record_hash: string;
  /** Optional provenance fields. Absent means UNVERIFIED, never "authentic". */
  source_url?: string;
  source_record_number?: number;
  provenance_status?: ProvenanceStatus;
}

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface RegionDefinition {
  id: string;
  name: string;
  country: string;
  bbox: BoundingBox;
  description: string;
  center: [number, number]; // [lng, lat]
  defaultZoom: number;
}

export interface SpatialTemporalCell {
  cell_id: string; // e.g. "cell_X_Y"
  grid_x: number;
  grid_y: number;
  date: string;
  center_lat: number;
  center_lon: number;
  modis_count: number;
  viirs_count: number;
  total_raw_count: number;
  modis_frp_sum: number;
  viirs_frp_sum: number;
  total_frp_sum: number;
  harmonized_activity_index: number; // Calibrated 1-km equivalent activity score
  dominant_sensor: SensorType | 'BOTH' | 'NONE';
  day_count: number;
  night_count: number;
}

export interface DailyActivitySummary {
  date: string;
  year: number;
  month: number;
  day: number;
  day_of_year: number;
  modis_detections: number;
  viirs_detections: number;
  total_raw_detections: number;
  harmonized_activity_units: number; // Calibrated fire activity index
  modis_frp_mw: number;
  viirs_frp_mw: number;
  total_frp_mw: number;
  mean_frp_mw: number;
  active_1km_cells: number;
  historical_baseline_median: number;
  historical_baseline_mad: number;
  anomaly_score: number; // Robust Z-score: (observed - median) / (1.4826 * MAD)
  anomaly_category: 'normal' | 'moderate_anomaly' | 'high_anomaly' | 'extreme_anomaly' | 'insufficient_data';
  /** Share of the day covered by valid overpasses, or null when not computed (unknown, not 100%). */
  observation_coverage_pct: number | null;
  data_quality: 'standard_science' | 'nrt' | 'mixed';
  /**
   * Coverage classification for this day. Only days with at least one observation are emitted
   * by the daily summariser; a missing date is NOT a zero-fire day.
   */
  coverage_status?: CoverageStatus;
}

export interface MonthlyActivitySummary {
  year: number;
  month: number;
  label: string;
  modis_detections: number;
  viirs_detections: number;
  harmonized_activity_units: number;
  total_frp_mw: number;
  active_days: number;
  max_single_day_activity: number;
  anomaly_days_count: number;
}

export interface CalibrationModelMetrics {
  model_id: string;
  model_version: string;
  algorithm: string;
  target_grid_km: number;
  sample_size_paired_cells: number;
  training_period: string;
  validation_period: string;
  /** Undefined metrics are null, never zero. */
  mae: number | null;
  rmse: number | null;
  mean_bias: number | null;
  r_squared: number | null;
  calibration_slope: number | null;
  calibration_intercept: number | null;
  status: CalibrationStatus;
  limitations: string[];
  /** Explicit evidence requirements for VALIDATED; empty when not applicable. */
  validation_criteria?: string[];
  n_training?: number;
  n_validation?: number;
  /** True only when an independent temporal/spatial holdout was actually evaluated. */
  independent_validation?: boolean;
}

export interface IngestionJob {
  id: string;
  sensor: SensorType;
  /** One satellite, or several joined with " + " when the job covers more than one. */
  satellite: string;
  region: string;
  date_range: string;
  /** Real job lifecycle. A job exists only because an execution record was created. */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** null while pending/running or when nothing was imported; never fabricated. */
  records_imported: number | null;
  source_endpoint: string;
  retrieved_at: string;
  /** SHA-256 of the preserved raw file; null when no file was downloaded. */
  checksum: string | null;
  error_message?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  source_products?: string[];
  provenance_status?: ProvenanceStatus;
  bbox?: string;
}

export interface FilterState {
  startDate: string;
  endDate: string;
  sensorMode: 'ALL' | 'MODIS_ONLY' | 'VIIRS_ONLY' | 'HARMONIZED';
  satellite: 'ALL' | SatelliteType;
  minConfidence: number;
  minFRP: number;
  dayNight: 'ALL' | 'D' | 'N';
}
