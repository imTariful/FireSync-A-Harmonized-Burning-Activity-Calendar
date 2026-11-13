/**
 * Scientific Harmonization Engine for MODIS & VIIRS active fire observations.
 *
 * Formulates comparable fire-activity indicators over a common spatial (1 km equal-area)
 * and temporal (daily) support framework. The fixed 0.294 VIIRS scale factor is an
 * EXPLORATORY assumption from the literature, not an empirically fitted Bangladesh
 * calibration coefficient. `evaluateCalibrationModel` evaluates that fixed coefficient;
 * `evaluateTemporalHoldout` is the only function that can ever return VALIDATED, and only
 * when every documented evidence requirement is met.
 */

import {
  CanonicalObservation,
  SpatialTemporalCell,
  CalibrationModelMetrics,
  DailyActivitySummary,
} from '../types/fire';
import { computeGridCellIndex, getCellCenterCoordinate } from './spatial';

/**
 * Standard parameters derived from peer-reviewed literature (Schroeder et al., 2014;
 * Giglio et al., 2016; Wooster et al., 2021) on VIIRS 375m vs MODIS 1km active fire detection.
 * VIIRS detects smaller and lower FRP fires, resulting in ~3.4x higher raw counts for equivalent burning.
 */
export const HARMONIZATION_CONSTANTS = {
  // VIIRS detection count scaling to MODIS 1-km equivalent baseline
  VIIRS_COUNT_SCALE_FACTOR: 0.294, // 1 / 3.4
  // Baseline scan-angle correction factor bounds
  MIN_SCAN_CORRECTION: 0.85,
  MAX_SCAN_CORRECTION: 1.25,
  // Minimum paired cell sample size required even to consider validation
  MIN_SAMPLE_FOR_VALIDATION: 50,
  // Explicit independent-validation requirements. All must be met for VALIDATED.
  MIN_TRAIN_FOR_VALIDATION: 30,
  MIN_VALIDATION_FOR_VALIDATION: 10,
};

/** The status shown when no calibration has been fitted or validated. */
export const EXPLORATORY_LABEL = 'EXPLORATORY' as const;

export interface PairedCalibrationCell {
  modis: number;
  viirs: number;
  /** ISO date used for temporal holdout separation. */
  date?: string;
}

export interface LinearFit {
  n: number;
  slope: number | null;
  intercept: number | null;
  /** null when n < 2 or the reference values have zero variance (undefined, never 0). */
  r_squared: number | null;
  slope_std_error: number | null;
  residual_std_error: number | null;
}

function finitePositiveOrZero(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Ordinary least squares y = intercept + slope * x.
 * Returns null coefficients when the fit is mathematically undefined.
 */
export function fitLinearModel(points: readonly { x: number; y: number }[]): LinearFit {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = usable.length;
  if (n < 2) {
    return { n, slope: null, intercept: null, r_squared: null, slope_std_error: null, residual_std_error: null };
  }
  const meanX = usable.reduce((s, p) => s + p.x, 0) / n;
  const meanY = usable.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of usable) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (!(sxx > 0)) {
    // The predictor has no variance: slope is undefined.
    return { n, slope: null, intercept: null, r_squared: null, slope_std_error: null, residual_std_error: null };
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  for (const p of usable) {
    const residual = p.y - (intercept + slope * p.x);
    ssRes += residual * residual;
  }
  const rSquared = syy > 0 ? 1 - ssRes / syy : null;
  const residualStdError = n > 2 ? Math.sqrt(ssRes / (n - 2)) : null;
  const slopeStdError = residualStdError !== null ? residualStdError / Math.sqrt(sxx) : null;
  return {
    n,
    slope,
    intercept,
    r_squared: rSquared === null || !Number.isFinite(rSquared) ? null : Number(rSquared.toFixed(4)),
    slope_std_error: slopeStdError === null || !Number.isFinite(slopeStdError) ? null : Number(slopeStdError.toFixed(6)),
    residual_std_error: residualStdError === null || !Number.isFinite(residualStdError) ? null : Number(residualStdError.toFixed(6)),
  };
}

/**
 * Independent temporal holdout: earliest `trainFraction` of paired cells train the model,
 * the latest remainder validates it. VALIDATED is returned only when every explicit
 * criterion is met; otherwise the status stays INSUFFICIENT.
 */
export function evaluateTemporalHoldout(
  pairedCells: readonly PairedCalibrationCell[],
  options: { trainFraction?: number; minTrain?: number; minValidation?: number } = {}
): CalibrationModelMetrics {
  const trainFraction = options.trainFraction ?? 0.7;
  const minTrain = options.minTrain ?? HARMONIZATION_CONSTANTS.MIN_TRAIN_FOR_VALIDATION;
  const minValidation = options.minValidation ?? HARMONIZATION_CONSTANTS.MIN_VALIDATION_FOR_VALIDATION;
  const criteria = [
    `At least ${minTrain} paired cells in the training split.`,
    `At least ${minValidation} paired cells in the independent validation split.`,
    'Temporal separation: every validation date is later than every training date.',
    'The validation reference (MODIS) has non-zero variance so R² is defined.',
    'The fitted slope, intercept, R², MAE, RMSE and bias are all finite.',
  ];

  const dated = pairedCells
    .filter((c) => typeof c.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.date))
    .slice()
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));

  // F18 fix: split on COMPLETE DATE GROUPS so no date appears in both splits.
  // The split fraction selects how many unique dates go into training.
  const uniqueDates = [...new Set(dated.map((c) => c.date!))].sort();
  const splitDateCount = Math.floor(uniqueDates.length * trainFraction);
  const trainCutoffDate = uniqueDates[splitDateCount - 1] ?? '';
  const train = dated.filter((c) => c.date! <= trainCutoffDate);
  const validation = dated.filter((c) => c.date! > trainCutoffDate);

  // F18 fix: explicitly assert strict temporal separation between splits.
  const maxTrainDate = train.length ? train[train.length - 1].date! : '';
  const minValDate = validation.length ? validation[0].date! : '';
  const temporallySeparated = train.length === 0 || validation.length === 0 || maxTrainDate < minValDate;

  const fit = fitLinearModel(train.map((c) => ({ x: c.viirs, y: c.modis })));

  // F19 fix: allow multiple spatial cells on the same validation date (remove per-row
  // monotonicity requirement). Temporal separation is enforced at the split boundary above.
  const complete =
    train.length >= minTrain &&
    validation.length >= minValidation &&
    temporallySeparated &&
    fit.slope !== null &&
    fit.intercept !== null &&
    fit.r_squared !== null;

  let mae: number | null = null;
  let rmse: number | null = null;
  let meanBias: number | null = null;
  let r2: number | null = null;
  if (fit.slope !== null && fit.intercept !== null && validation.length > 0) {
    let sumAbs = 0;
    let sumSq = 0;
    let sumBias = 0;
    let sumObs = 0;
    for (const v of validation) {
      const pred = fit.intercept + fit.slope * v.viirs;
      const diff = pred - v.modis;
      sumAbs += Math.abs(diff);
      sumSq += diff * diff;
      sumBias += diff;
      sumObs += v.modis;
    }
    mae = Number((sumAbs / validation.length).toFixed(4));
    rmse = Number(Math.sqrt(sumSq / validation.length).toFixed(4));
    meanBias = Number((sumBias / validation.length).toFixed(4));
    // F20 fix: compute holdout R² from the TRAINING model's predictions against
    // the validation reference. Never refit the model on holdout labels.
    const meanValObs = sumObs / validation.length;
    let ssTot = 0;
    for (const v of validation) ssTot += Math.pow(v.modis - meanValObs, 2);
    // R² is undefined (null) when reference variance is zero; negative values are real and preserved.
    r2 = ssTot > 0 && Number.isFinite(sumSq) ? Number((1 - sumSq / ssTot).toFixed(4)) : null;
  }

  const allFinite =
    [fit.slope, fit.intercept, fit.r_squared, mae, rmse, meanBias, r2].every(
      (v) => typeof v === 'number' && Number.isFinite(v)
    );
  const validated = complete && allFinite && r2 !== null;

  return {
    model_id: 'cal-modis-viirs-holdout',
    model_version: '2.0.0',
    algorithm: 'Ordinary least squares with temporal holdout',
    target_grid_km: 1.0,
    sample_size_paired_cells: dated.length,
    training_period: train.length
      ? `${train[0].date} to ${train[train.length - 1].date}`
      : 'no dated training cells',
    validation_period: validation.length
      ? `${validation[0].date} to ${validation[validation.length - 1].date}`
      : 'no dated validation cells',
    mae,
    rmse,
    mean_bias: meanBias,
    r_squared: r2,
    calibration_slope: fit.slope === null ? null : Number(fit.slope.toFixed(4)),
    calibration_intercept: fit.intercept === null ? null : Number(fit.intercept.toFixed(4)),
    // EXPLORATORY describes the harmonization layer, not a calibration result. Until every
    // explicit holdout criterion is met, the calibration status is INSUFFICIENT.
    status: validated ? 'VALIDATED' : 'INSUFFICIENT',
    limitations: validated
      ? [
          'Holdout agreement is not ground-truth validation; MODIS is used as the reference sensor.',
          'Paired cells are co-detections only and do not represent non-detection opportunities.',
        ]
      : [
          `Training cells: ${train.length} (need ${minTrain}); validation cells: ${validation.length} (need ${minValidation}).`,
          'Independent temporal holdout has not met the evidence requirements, so the model is not VALIDATED.',
          'In-sample agreement must never be reported as independent validation.',
        ],
    validation_criteria: criteria,
    n_training: train.length,
    n_validation: validation.length,
    independent_validation: validated,
  };
}

/**
 * Aggregates a collection of canonical observations into spatial-temporal 1-km equal area cells.
 */
export function aggregateToSpatialTemporalGrid(
  observations: CanonicalObservation[],
  cellSizeKm = 1.0
): Map<string, SpatialTemporalCell> {
  const cellMap = new Map<string, SpatialTemporalCell>();

  for (const obs of observations) {
    const { gridX, gridY, cellKey } = computeGridCellIndex(
      obs.latitude,
      obs.longitude,
      cellSizeKm
    );
    const key = `${obs.acq_date}_${cellKey}`;

    let cell = cellMap.get(key);
    if (!cell) {
      const center = getCellCenterCoordinate(gridX, gridY, cellSizeKm);
      cell = {
        cell_id: key,
        grid_x: gridX,
        grid_y: gridY,
        date: obs.acq_date,
        center_lat: center.lat,
        center_lon: center.lon,
        modis_count: 0,
        viirs_count: 0,
        total_raw_count: 0,
        modis_frp_sum: 0,
        viirs_frp_sum: 0,
        total_frp_sum: 0,
        harmonized_activity_index: 0,
        dominant_sensor: 'NONE',
        day_count: 0,
        night_count: 0,
      };
      cellMap.set(key, cell);
    }

    cell.total_raw_count += 1;
    cell.total_frp_sum += obs.frp_mw;

    if (obs.sensor === 'MODIS') {
      cell.modis_count += 1;
      cell.modis_frp_sum += obs.frp_mw;
    } else {
      cell.viirs_count += 1;
      cell.viirs_frp_sum += obs.frp_mw;
    }

    if (obs.daynight === 'D') {
      cell.day_count += 1;
    } else {
      cell.night_count += 1;
    }
  }

  // Calculate harmonized activity index and dominant sensor for each cell
  for (const cell of cellMap.values()) {
    if (cell.modis_count > 0 && cell.viirs_count > 0) {
      cell.dominant_sensor = 'BOTH';
      // When both sensors observe the cell on the same day:
      // Weight MODIS 1-km resolution with VIIRS sub-pixel sensitivity
      const calibratedViirsActivity =
        cell.viirs_count * HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR;
      // Blended activity: maximum of MODIS count and calibrated VIIRS count,
      // plus FRP density adjustment
      cell.harmonized_activity_index = Number(
        (
          0.5 * cell.modis_count +
          0.5 * calibratedViirsActivity +
          0.005 * Math.log1p(cell.total_frp_sum)
        ).toFixed(3)
      );
    } else if (cell.modis_count > 0) {
      cell.dominant_sensor = 'MODIS';
      // Pure MODIS 1km activity index
      cell.harmonized_activity_index = Number(
        (
          cell.modis_count +
          0.004 * Math.log1p(cell.modis_frp_sum)
        ).toFixed(3)
      );
    } else {
      cell.dominant_sensor = 'VIIRS';
      // Pure VIIRS: Calibrate to MODIS 1-km standard equivalent units
      cell.harmonized_activity_index = Number(
        (
          cell.viirs_count * HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR +
          0.004 * Math.log1p(cell.viirs_frp_sum)
        ).toFixed(3)
      );
    }
  }

  return cellMap;
}

/**
 * Evaluates the FIXED exploratory coefficient against paired 1-km cells (in-sample).
 * This is not a fitted model and can never return VALIDATED. A fitted model with an
 * independent holdout is produced by `evaluateTemporalHoldout`.
 */
export function evaluateCalibrationModel(
  pairedCells: readonly PairedCalibrationCell[],
  calibrationSlope = HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR,
  calibrationIntercept = 0.05
): CalibrationModelMetrics {
  const usable = pairedCells.filter(
    (p) => finitePositiveOrZero(p.modis) && finitePositiveOrZero(p.viirs)
  );
  const n = usable.length;
  const criteria = [
    `At least ${HARMONIZATION_CONSTANTS.MIN_SAMPLE_FOR_VALIDATION} paired 1-km cells.`,
    'Non-zero MODIS reference variance so R² is defined.',
    'An independent temporal or spatial holdout that the model was not fitted on.',
    'Finite slope uncertainty and holdout error metrics.',
  ];

  if (n === 0) {
    return {
      model_id: 'cal-modis-viirs-v1',
      model_version: '2.0.0',
      algorithm: 'Fixed exploratory coefficient (not fitted)',
      target_grid_km: 1.0,
      sample_size_paired_cells: 0,
      training_period: 'none (fixed coefficient, not fitted)',
      validation_period: 'none (no independent holdout)',
      mae: null,
      rmse: null,
      mean_bias: null,
      r_squared: null,
      calibration_slope: calibrationSlope,
      calibration_intercept: calibrationIntercept,
      status: 'INSUFFICIENT',
      limitations: [
        'No paired MODIS–VIIRS 1-km cells are available, so no metric can be computed.',
        'Missing paired cells are not evidence of zero fire activity.',
      ],
      validation_criteria: criteria,
      n_training: 0,
      n_validation: 0,
      independent_validation: false,
    };
  }

  let sumAbsError = 0;
  let sumSqError = 0;
  let sumBias = 0;
  let sumObs = 0;
  for (const pair of usable) {
    const yObs = pair.modis;
    const yPred = calibrationIntercept + calibrationSlope * pair.viirs;
    const diff = yPred - yObs;
    sumAbsError += Math.abs(diff);
    sumSqError += diff * diff;
    sumBias += diff;
    sumObs += yObs;
  }

  const mae = Number((sumAbsError / n).toFixed(4));
  const rmse = Number(Math.sqrt(sumSqError / n).toFixed(4));
  const meanBias = Number((sumBias / n).toFixed(4));

  const meanObs = sumObs / n;
  let ssTot = 0;
  for (const pair of usable) ssTot += Math.pow(pair.modis - meanObs, 2);
  // Undefined R² must be null. Zero is a real value and would falsely look like a measured fit.
  // F21 fix: preserve genuine negative R² values; a model worse than the mean baseline is NOT zero.
  const rSquared =
    n >= 2 && ssTot > 0 && Number.isFinite(sumSqError)
      ? Number((1 - sumSqError / ssTot).toFixed(4))
      : null;

  const enoughForConsideration = n >= HARMONIZATION_CONSTANTS.MIN_SAMPLE_FOR_VALIDATION;
  // This function is in-sample only. It can describe agreement, but it cannot validate the model,
  // so the calibration status stays INSUFFICIENT until an independent holdout meets every criterion.
  const status = 'INSUFFICIENT';

  return {
    model_id: 'cal-modis-viirs-v1',
    model_version: '2.0.0',
    algorithm: 'Fixed exploratory coefficient (not fitted)',
    target_grid_km: 1.0,
    sample_size_paired_cells: n,
    training_period: 'none (fixed coefficient, not fitted)',
    validation_period: 'none (in-sample, no temporal holdout)',
    mae,
    rmse,
    mean_bias: meanBias,
    r_squared: rSquared,
    calibration_slope: Number(calibrationSlope.toFixed(4)),
    calibration_intercept: Number(calibrationIntercept.toFixed(4)),
    status,
    limitations: [
      ...(enoughForConsideration
        ? []
        : [
            `Only ${n} paired 1-km cells (at least ${HARMONIZATION_CONSTANTS.MIN_SAMPLE_FOR_VALIDATION} are required even to consider validation).`,
          ]),
      ...(ssTot === 0
        ? ['Reference variance is zero (every MODIS count is identical), so R² is undefined and reported as null.']
        : []),
      'The 0.294 scale factor is a fixed exploratory assumption from the literature, not a fitted Bangladesh coefficient.',
      'Metrics are in-sample: no independent temporal or spatial holdout has been evaluated.',
      'Agreement with a MODIS reference does not constitute direct ground-truth validation.',
      'Cloud occlusion and differing overpass times affect diurnal fire detection.',
      'Bow-tie pixel expansion in MODIS off-nadir tracks increases uncertainty at scan edges.',
    ],
    validation_criteria: criteria,
    n_training: n,
    n_validation: 0,
    independent_validation: false,
  };
}

/**
 * Summarizes spatial-temporal cells into daily burning-activity summaries.
 *
 * IMPORTANT: only dates that actually contain at least one observation are emitted.
 * A missing date means "no observation opportunity is known", NOT zero fire. The calendar
 * and anomaly code must therefore treat an absent date as unknown coverage.
 */
export function buildDailySummariesFromCells(
  cells: SpatialTemporalCell[],
  dateRange: { start: string; end: string },
  options?: { today?: string; observations?: CanonicalObservation[] }
): DailyActivitySummary[] {
  // F24 fix: derive per-day data quality from actual contributing observations.
  // Build a date → quality-class map from the observations when supplied.
  const dateQuality = new Map<string, 'nrt' | 'standard_science' | 'mixed'>();
  if (options?.observations) {
    const NRT_PRODUCTS = new Set(['MODIS_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA21_NRT']);
    for (const obs of options.observations) {
      const isNrt = NRT_PRODUCTS.has(obs.product ?? '');
      const existing = dateQuality.get(obs.acq_date);
      if (!existing) {
        dateQuality.set(obs.acq_date, isNrt ? 'nrt' : 'standard_science');
      } else if (existing !== (isNrt ? 'nrt' : 'standard_science')) {
        dateQuality.set(obs.acq_date, 'mixed');
      }
    }
  }
  const dailyMap = new Map<string, {
    modis_detections: number;
    viirs_detections: number;
    harmonized_units: number;
    modis_frp: number;
    viirs_frp: number;
    total_frp: number;
    active_cells: number;
    qualities: Set<'standard_science' | 'nrt' | 'mixed'>;
  }>();

  for (const cell of cells) {
    if (cell.date < dateRange.start || cell.date > dateRange.end) continue;
    let day = dailyMap.get(cell.date);
    if (!day) {
      day = {
        modis_detections: 0,
        viirs_detections: 0,
        harmonized_units: 0,
        modis_frp: 0,
        viirs_frp: 0,
        total_frp: 0,
        active_cells: 0,
        qualities: new Set(),
      };
      dailyMap.set(cell.date, day);
    }
    day.modis_detections += cell.modis_count;
    day.viirs_detections += cell.viirs_count;
    day.harmonized_units += cell.harmonized_activity_index;
    day.modis_frp += cell.modis_frp_sum;
    day.viirs_frp += cell.viirs_frp_sum;
    day.total_frp += cell.total_frp_sum;
    day.active_cells += 1;
  }

  // Days after today cannot have observations: never emit them as "quiet" days.
  const todayStr = options?.today ?? new Date().toISOString().slice(0, 10);
  const results: DailyActivitySummary[] = [];
  for (const [dateStr, dayData] of [...dailyMap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (dateStr > todayStr) continue;
    const curr = new Date(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(curr.getTime())) continue;
    const year = curr.getUTCFullYear();
    const month = curr.getUTCMonth() + 1;
    const day = curr.getUTCDate();
    const dayOfYear = Math.floor(
      (curr.getTime() - new Date(Date.UTC(year, 0, 0)).getTime()) /
        (1000 * 60 * 60 * 24)
    );

    const totalRaw = dayData.modis_detections + dayData.viirs_detections;
    const meanFrp = totalRaw > 0 ? Number((dayData.total_frp / totalRaw).toFixed(1)) : 0;

    results.push({
      date: dateStr,
      year,
      month,
      day,
      day_of_year: dayOfYear,
      modis_detections: dayData.modis_detections,
      viirs_detections: dayData.viirs_detections,
      total_raw_detections: totalRaw,
      harmonized_activity_units: Number(dayData.harmonized_units.toFixed(2)),
      modis_frp_mw: Number(dayData.modis_frp.toFixed(1)),
      viirs_frp_mw: Number(dayData.viirs_frp.toFixed(1)),
      total_frp_mw: Number(dayData.total_frp.toFixed(1)),
      mean_frp_mw: meanFrp,
      active_1km_cells: dayData.active_cells,
      historical_baseline_median: 0,
      historical_baseline_mad: 0,
      anomaly_score: 0,
      anomaly_category: 'normal',
      // Per-day overpass coverage is not computed in this build. Unknown is NOT 100% (and NOT zero fire).
      observation_coverage_pct: null,
      // F24 fix: use the derived per-day quality; default to 'nrt' (conservative) when unknown.
      data_quality: dateQuality.get(dateStr) ?? 'nrt',
      coverage_status: 'observed',
    });
  }

  return results;
}
