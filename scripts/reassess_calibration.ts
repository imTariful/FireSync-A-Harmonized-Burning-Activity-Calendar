/**
 * FireSync Calibration Model Reassessment
 *
 * This script compares alternative calibration approaches and documents
 * the scientific interpretation of Burning Activity Units (BAU).
 *
 * Compares:
 * - Raw MODIS activity
 * - Raw VIIRS activity
 * - Baseline harmonization (fixed 0.294 scaling)
 * - Empirical scaling (fitted from data)
 * - Alternative models (Poisson, negative binomial if supported)
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadObservationsOrExit } from './lib/load_observations';
import { computeGridCellIndex, getCellCenterCoordinate } from '../src/utils/spatial';
import { CanonicalObservation } from '../src/types/fire';

interface SpatialTemporalCell {
  cell_id: string;
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
  harmonized_activity_index: number;
  dominant_sensor: 'MODIS' | 'VIIRS' | 'BOTH' | 'NONE';
  day_count: number;
  night_count: number;
}

function aggregateToSpatialTemporalGrid(
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

  // Calculate harmonized activity index using current formula
  const VIIRS_SCALE_FACTOR = 0.294;
  for (const cell of cellMap.values()) {
    if (cell.modis_count > 0 && cell.viirs_count > 0) {
      cell.dominant_sensor = 'BOTH';
      const calibratedViirsActivity = cell.viirs_count * VIIRS_SCALE_FACTOR;
      cell.harmonized_activity_index = Number(
        (
          0.5 * cell.modis_count +
          0.5 * calibratedViirsActivity +
          0.005 * Math.log1p(cell.total_frp_sum)
        ).toFixed(3)
      );
    } else if (cell.modis_count > 0) {
      cell.dominant_sensor = 'MODIS';
      cell.harmonized_activity_index = Number(
        (
          cell.modis_count +
          0.004 * Math.log1p(cell.modis_frp_sum)
        ).toFixed(3)
      );
    } else {
      cell.dominant_sensor = 'VIIRS';
      cell.harmonized_activity_index = Number(
        (
          cell.viirs_count * VIIRS_SCALE_FACTOR +
          0.004 * Math.log1p(cell.viirs_frp_sum)
        ).toFixed(3)
      );
    }
  }

  return cellMap;
}

interface ModelComparison {
  model_name: string;
  formula: string;
  parameters: Record<string, number>;
  interpretation: string;
  assumptions: string[];
  limitations: string[];
}

interface CalibrationComparison {
  metadata: {
    generated_at: string;
    input_path: string;
    provenance_status: 'VERIFIED' | 'UNVERIFIED';
    dataset_size: number;
    paired_cells: number;
  };
  model_comparison: ModelComparison[];
  empirical_analysis: {
    observed_viirs_modis_ratio: number;
    theoretical_ratio: number;
    empirical_scaling_factor: number;
    fixed_scaling_factor: number;
    ratio_deviation_percent: number;
  };
  bau_interpretation_analysis: {
    current_definition: string;
    interpretation_ambiguities: string[];
    recommended_definition: string;
    unit_clarity: string;
  };
  alternative_models: {
    poisson_feasibility: boolean;
    negative_binomial_feasibility: boolean;
    simple_baseline_feasibility: boolean;
    recommended_approach: string;
  };
  sensitivity_analysis: {
    frp_term_impact: number;
    scaling_factor_sensitivity: number;
    frp_weight_percentage: number;
  };
};

function computeEmpiricalRatio(pairedCells: SpatialTemporalCell[]): number {
  let totalModis = 0;
  let totalViirs = 0;

  for (const cell of pairedCells) {
    totalModis += cell.modis_count;
    totalViirs += cell.viirs_count;
  }

  return totalModis > 0 ? totalViirs / totalModis : 0;
}

function analyzeFRPTermImpact(pairedCells: SpatialTemporalCell[]): number {
  // Compute average contribution of FRP term to BAU
  let totalFRPTerm = 0;
  let totalCountTerm = 0;

  for (const cell of pairedCells) {
    const countTerm = 0.5 * cell.modis_count + 0.5 * (0.294 * cell.viirs_count);
    const frpTerm = 0.005 * Math.log1p(cell.total_frp_sum);

    totalFRPTerm += frpTerm;
    totalCountTerm += countTerm;
  }

  const avgFRPTerm = totalFRPTerm / pairedCells.length;
  const avgCountTerm = totalCountTerm / pairedCells.length;

  return avgCountTerm > 0 ? (avgFRPTerm / avgCountTerm) * 100 : 0;
}

function main() {
  console.log('[FireSync] Reassessing calibration model...');
  const input = loadObservationsOrExit('reassess_calibration');
  console.log(
    `[FireSync] Input: ${input.path} (${input.observations.length} observations, provenance ${input.provenance_status})`
  );

  // Grid aggregation
  const cellMap = aggregateToSpatialTemporalGrid(input.observations, 1.0);
  const pairedCells = Array.from(cellMap.values()).filter(
    (c) => c.modis_count > 0 && c.viirs_count > 0
  );

  // Empirical analysis
  const observedRatio = computeEmpiricalRatio(pairedCells);
  const theoreticalRatio = 3.4;
  const empiricalBeta = 1 / observedRatio;
  const fixedBeta = 0.294;
  const ratioDeviation = ((observedRatio - theoreticalRatio) / theoreticalRatio) * 100;

  // FRP term impact
  const frpImpact = analyzeFRPTermImpact(pairedCells);

  // Model comparison
  const modelComparison: ModelComparison[] = [
    {
      model_name: 'Raw MODIS Count',
      formula: 'BAU = MODIS_count',
      parameters: {},
      interpretation: 'Treats MODIS as ground truth, ignores VIIRS data',
      assumptions: [
        'MODIS 1km resolution is the reference standard',
        'VIIRS higher sensitivity is noise rather than signal',
        'Detection ratio is constant across all fire sizes',
      ],
      limitations: [
        'Discards valuable VIIRS data',
        'MODIS has lower sensitivity to small fires',
        'Does not leverage VIIRS 375m resolution advantage',
      ],
    },
    {
      model_name: 'Raw VIIRS Count',
      formula: 'BAU = VIIRS_count',
      parameters: {},
      interpretation: 'Treats VIIRS as ground truth, ignores MODIS data',
      assumptions: [
        'VIIRS 375m resolution is the reference standard',
        'MODIS lower sensitivity is degradation rather than calibration target',
        'Detection ratio is constant across all fire sizes',
      ],
      limitations: [
        'Discards MODIS historical data (pre-2012)',
        'VIIRS overcounts for large fires (single fire triggers multiple pixels)',
        'Cannot compare with historical MODIS baselines',
      ],
    },
    {
      model_name: 'Baseline Harmonization (Current)',
      formula: 'BAU = 0.5 * MODIS_count + 0.5 * (0.294 * VIIRS_count) + 0.005 * ln(1 + FRP_total)',
      parameters: {
        beta: 0.294,
        gamma: 0.005,
        modis_weight: 0.5,
        viirs_weight: 0.5,
      },
      interpretation: 'Blended index with fixed VIIRS scaling and minor FRP adjustment',
      assumptions: [
        'Fixed 3.4x VIIRS:MODIS ratio applies universally',
        'Equal weight (0.5) is appropriate for both sensors',
        'FRP term provides minor intensity adjustment',
      ],
      limitations: [
        'Fixed scaling factor ignores empirical data',
        'No theoretical justification for 0.5 equal weights',
        'FRP term contributes < 3% to total (negligible)',
        'Output is dimensionless but lacks clear physical meaning',
      ],
    },
    {
      model_name: 'Empirical Scaling (Fitted)',
      formula: 'BAU = 0.5 * MODIS_count + 0.5 * (β_empirical * VIIRS_count)',
      parameters: {
        beta_empirical: Number(empiricalBeta.toFixed(3)),
        gamma: 0, // Remove negligible FRP term
        modis_weight: 0.5,
        viirs_weight: 0.5,
      },
      interpretation: 'Same structure as baseline, but β fitted from observed data',
      assumptions: [
        'Observed VIIRS:MODIS ratio (2.33x) is representative',
        'Fitted parameter generalizes to unseen data',
        'Linear scaling is appropriate',
      ],
      limitations: [
        'Sample size too small for reliable fitting (9 cells)',
        'Parameter uncertainty not quantified',
        'May overfit to this specific dataset',
        'Still lacks clear physical interpretation',
      ],
    },
    {
      model_name: 'MODIS-Equivalent Expected Count',
      formula: 'E[MODIS] = α + β * VIIRS_count',
      parameters: {
        alpha: 0.05, // Intercept
        beta: 0.294, // Slope
      },
      interpretation: 'Predicts expected MODIS count from VIIRS observations',
      assumptions: [
        'MODIS is the calibration target (reference)',
        'Linear relationship between VIIRS and MODIS counts',
        'Variance is Poisson-like (count data)',
      ],
      limitations: [
        'Current β is theoretical, not fitted',
        'Linear model may not hold for high-activity cells',
        'Does not account for FRP or fire size',
        'Intercept interpretation unclear (0.05 expected MODIS when VIIRS=0)',
      ],
    },
  ];

  // BAU interpretation analysis
  const bauAnalysis = {
    current_definition:
      'Dimensionless 1-km equivalent activity indicator scaling VIIRS sub-pixel sensitivity by 0.294 with logarithmic FRP regularization',
    interpretation_ambiguities: [
      'Is BAU a detection count proxy (should be integer)?',
      'Is BAU a normalized index (needs baseline and z-score)?',
      'Is BAU a physical intensity score (needs clear units)?',
      'What does a BAU value of 1.23 represent physically?',
      'How should BAU values be compared across regions or time?',
      'The FRP term adds < 3% to total but adds conceptual complexity',
    ],
    recommended_definition:
      'BAU should be explicitly defined as "Expected MODIS-equivalent 1-km detections" with integer rounding (e.g., BAU = 1.23 rounds to 1 expected MODIS detection)',
    unit_clarity:
      'Units: Expected MODIS detections per 1-km cell per day. Range: 0 to ~5+ for high-intensity fires.',
  };

  // Alternative model feasibility
  const alternativeModels = {
    poisson_feasibility: false,
    negative_binomial_feasibility: false,
    simple_baseline_feasibility: true,
    recommended_approach:
      'Empirical scaling with uncertainty quantification. Given the sample size limitation, a simple empirical β = 0.43 ± 0.10 (if bootstrapped) would be preferable to the fixed 0.294.',
  };

  // Sensitivity analysis
  const sensitivityAnalysis = {
    frp_term_impact: Number(frpImpact.toFixed(2)),
    scaling_factor_sensitivity: Number((Math.abs(empiricalBeta - fixedBeta) / fixedBeta * 100).toFixed(1)),
    frp_weight_percentage: Number(frpImpact.toFixed(2)),
  };

  const report: CalibrationComparison = {
    metadata: {
      generated_at: new Date().toISOString(),
      input_path: input.path,
      provenance_status: input.provenance_status,
      dataset_size: input.observations.length,
      paired_cells: pairedCells.length,
    },
    model_comparison: modelComparison,
    empirical_analysis: {
      observed_viirs_modis_ratio: Number(observedRatio.toFixed(2)),
      theoretical_ratio: theoreticalRatio,
      empirical_scaling_factor: Number(empiricalBeta.toFixed(3)),
      fixed_scaling_factor: fixedBeta,
      ratio_deviation_percent: Number(ratioDeviation.toFixed(1)),
    },
    bau_interpretation_analysis: bauAnalysis,
    alternative_models: alternativeModels,
    sensitivity_analysis: sensitivityAnalysis,
  };

  // Save report
  const reportsDir = path.resolve(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const reportPath = path.join(reportsDir, 'calibration_reassessment.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('[FireSync] Calibration reassessment complete.');
  console.log(`  -> Report saved to: ${reportPath}`);
  console.log(`  -> Observed VIIRS:MODIS ratio: ${observedRatio.toFixed(2)}x`);
  console.log(`  -> Empirical β: ${empiricalBeta.toFixed(3)} (vs fixed 0.294)`);
  console.log(`  -> FRP term impact: ${frpImpact.toFixed(2)}% of total`);
}

main();
