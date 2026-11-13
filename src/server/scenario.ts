/**
 * Fire Behavior Scenario Laboratory — deterministic, educational core.
 *
 * This module validates hypothetical environmental inputs and produces QUALITATIVE context only.
 * It is not a fire-spread model: no rate of spread, flame length, perimeter or arrival time is
 * computed or implied. Real simulation requires a specialist, validated fire-behaviour model,
 * which is not integrated — `simulation.available` is always false and the reason is stated.
 */

import type { ValidationResult } from './ai/schema';

export const SCENARIO_FUEL_TYPES = [
  'grass',
  'shrub',
  'timber_litter',
  'peat',
  'crop_residue',
  'mixed',
] as const;

export type ScenarioFuelType = (typeof SCENARIO_FUEL_TYPES)[number];

export interface ScenarioInput {
  wind_speed_kmh: number;
  wind_direction_deg?: number;
  relative_humidity_pct: number;
  fuel: ScenarioFuelType;
  slope_degrees?: number;
  fuel_moisture_pct?: number;
}

export interface ScenarioFactor {
  factor: string;
  category: string;
  direction: 'favors_spread' | 'limits_spread' | 'context_dependent' | 'neutral';
  note: string;
}

export interface ScenarioAssessment {
  kind: 'educational_scenario';
  inputs: ScenarioInput;
  factors: ScenarioFactor[];
  simulation: {
    available: false;
    reason: string;
  };
  disclaimer: string;
  limitations: string[];
}

const DISCLAIMER =
  'Educational scenario only. This is not a fire spread prediction, a fire behaviour model output, or an operational forecast.';

const SIMULATION_REASON =
  'No validated specialist fire-behaviour model is integrated. Quantitative spread rates, perimeters and arrival times are never produced here or by the AI explanation.';

function num(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

function inRange(value: number | undefined, min: number, max: number): value is number {
  return value !== undefined && Number.isFinite(value) && value >= min && value <= max;
}

/** Validate the hypothetical scenario inputs. Bounds are plausible input limits, not model outputs. */
export function parseScenarioRequest(body: unknown): ValidationResult<ScenarioInput> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const raw = body as Record<string, unknown>;

  const windSpeed = num(raw.wind_speed_kmh);
  if (!inRange(windSpeed, 0, 200)) {
    return { ok: false, error: 'wind_speed_kmh must be a number between 0 and 200.' };
  }

  const humidity = num(raw.relative_humidity_pct);
  if (!inRange(humidity, 0, 100)) {
    return { ok: false, error: 'relative_humidity_pct must be a number between 0 and 100.' };
  }

  const fuel = raw.fuel;
  if (typeof fuel !== 'string' || !(SCENARIO_FUEL_TYPES as readonly string[]).includes(fuel)) {
    return {
      ok: false,
      error: `fuel must be one of: ${SCENARIO_FUEL_TYPES.join(', ')}.`,
    };
  }

  const input: ScenarioInput = {
    wind_speed_kmh: windSpeed,
    relative_humidity_pct: humidity,
    fuel: fuel as ScenarioFuelType,
  };

  if (raw.wind_direction_deg !== undefined && raw.wind_direction_deg !== null && raw.wind_direction_deg !== '') {
    const dir = num(raw.wind_direction_deg);
    if (!inRange(dir, 0, 360)) {
      return { ok: false, error: 'wind_direction_deg must be a number between 0 and 360.' };
    }
    input.wind_direction_deg = dir;
  }

  if (raw.slope_degrees !== undefined && raw.slope_degrees !== null && raw.slope_degrees !== '') {
    const slope = num(raw.slope_degrees);
    if (!inRange(slope, 0, 60)) {
      return { ok: false, error: 'slope_degrees must be a number between 0 and 60.' };
    }
    input.slope_degrees = slope;
  }

  if (raw.fuel_moisture_pct !== undefined && raw.fuel_moisture_pct !== null && raw.fuel_moisture_pct !== '') {
    const moisture = num(raw.fuel_moisture_pct);
    if (!inRange(moisture, 0, 60)) {
      return { ok: false, error: 'fuel_moisture_pct must be a number between 0 and 60.' };
    }
    input.fuel_moisture_pct = moisture;
  }

  return { ok: true, value: input };
}

const FUEL_NOTES: Record<ScenarioFuelType, { category: string; direction: ScenarioFactor['direction']; note: string }> = {
  grass: {
    category: 'fine fuel',
    direction: 'context_dependent',
    note: 'Grass is a fine fuel that dries and cures quickly; in dry, windy conditions it can carry fire readily, while green or recently wetted grass resists ignition.',
  },
  shrub: {
    category: 'fine-to-medium fuel',
    direction: 'context_dependent',
    note: 'Shrub fuels vary widely in structure and moisture; live foliage holds moisture while dead fine fuels between stems can carry surface fire.',
  },
  timber_litter: {
    category: 'medium fuel',
    direction: 'context_dependent',
    note: 'Timber and litter fuels burn with longer residence times than grass; moisture content and compaction strongly affect how readily they ignite.',
  },
  peat: {
    category: 'smouldering fuel',
    direction: 'limits_spread',
    note: 'Peat burns by smouldering rather than flaming spread; it can persist for long periods but does not produce the rapid forward spread of surface fuels.',
  },
  crop_residue: {
    category: 'agricultural residue',
    direction: 'context_dependent',
    note: 'Crop residue is typically fine and cured after harvest, but moisture at harvest and residue height change how it burns.',
  },
  mixed: {
    category: 'mixed fuels',
    direction: 'context_dependent',
    note: 'Mixed fuel beds combine fine and heavier fuels; fire behaviour depends on which fuel class dominates at the surface and how they are arranged.',
  },
};

function windFactor(kmh: number): ScenarioFactor {
  if (kmh < 10) {
    return {
      factor: 'wind',
      category: 'low',
      direction: 'limits_spread',
      note: 'Low wind speeds reduce the rate at which a surface fire can be pushed forward and favour more symmetrical spread.',
    };
  }
  if (kmh < 30) {
    return {
      factor: 'wind',
      category: 'moderate',
      direction: 'context_dependent',
      note: 'Moderate wind can increase forward spread of fine fuels; the effect depends strongly on fuel type and moisture.',
    };
  }
  return {
    factor: 'wind',
    category: 'high',
    direction: 'favors_spread',
    note: 'High wind speeds generally increase forward spread potential, especially in fine fuels, but also raise spotting and erratic behaviour risk.',
  };
}

function humidityFactor(pct: number): ScenarioFactor {
  if (pct < 20) {
    return {
      factor: 'relative_humidity',
      category: 'very dry',
      direction: 'favors_spread',
      note: 'Very low humidity lets fine fuels dry out, lowering the moisture needed for ignition and sustaining spread.',
    };
  }
  if (pct < 40) {
    return {
      factor: 'relative_humidity',
      category: 'dry',
      direction: 'favors_spread',
      note: 'Dry air accelerates fuel drying between wetting events and generally supports more active fire spread.',
    };
  }
  if (pct < 60) {
    return {
      factor: 'relative_humidity',
      category: 'moderate',
      direction: 'context_dependent',
      note: 'Moderate humidity slows drying; spread depends on recent rain, fuel type and time since wetting.',
    };
  }
  return {
    factor: 'relative_humidity',
    category: 'humid',
    direction: 'limits_spread',
    note: 'Humid air keeps fuels wetter and generally limits ignition and spread unless fuels are already very dry.',
  };
}

function slopeFactor(deg: number): ScenarioFactor {
  if (deg < 10) {
    return {
      factor: 'slope',
      category: 'gentle',
      direction: 'neutral',
      note: 'Gentle slopes have a small effect on spread compared with wind and fuel conditions.',
    };
  }
  if (deg < 20) {
    return {
      factor: 'slope',
      category: 'moderate',
      direction: 'favors_spread',
      note: 'Moderate upslope runs can noticeably increase spread because flames pre-heat fuel above them.',
    };
  }
  return {
    factor: 'slope',
    category: 'steep',
    direction: 'favors_spread',
    note: 'Steep slopes can strongly increase upslope spread; fires typically spread slower downhill.',
  };
}

function moistureFactor(pct: number): ScenarioFactor {
  if (pct < 6) {
    return {
      factor: 'fuel_moisture',
      category: 'very dry',
      direction: 'favors_spread',
      note: 'Very dry fuel needs little additional heating to ignite and supports vigorous spread.',
    };
  }
  if (pct < 12) {
    return {
      factor: 'fuel_moisture',
      category: 'dry',
      direction: 'favors_spread',
      note: 'Dry fuel ignites and spreads more readily than moist fuel, though heavy fuels still resist.',
    };
  }
  if (pct < 25) {
    return {
      factor: 'fuel_moisture',
      category: 'moist',
      direction: 'limits_spread',
      note: 'Moist fuel requires more heat to ignite; fine fuels may still carry fire once dry pockets form.',
    };
  }
  return {
    factor: 'fuel_moisture',
    category: 'wet',
    direction: 'limits_spread',
    note: 'Wet fuel strongly resists ignition and sustained spread; smouldering may persist in heavy fuels.',
  };
}

/**
 * Build the deterministic educational assessment. Every statement is qualitative and directional;
 * no rate of spread, distance, area or time is produced.
 */
export function buildScenarioAssessment(input: ScenarioInput): ScenarioAssessment {
  const factors: ScenarioFactor[] = [
    windFactor(input.wind_speed_kmh),
    humidityFactor(input.relative_humidity_pct),
    { factor: 'fuel', ...FUEL_NOTES[input.fuel] },
  ];

  if (input.wind_direction_deg !== undefined) {
    factors.push({
      factor: 'wind_direction',
      category: `${Math.round(input.wind_direction_deg)}°`,
      direction: 'context_dependent',
      note: 'Wind direction matters relative to slope, valleys and fuel arrangement; without terrain data its effect cannot be resolved.',
    });
  }
  if (input.slope_degrees !== undefined) {
    factors.push(slopeFactor(input.slope_degrees));
  }
  if (input.fuel_moisture_pct !== undefined) {
    factors.push(moistureFactor(input.fuel_moisture_pct));
  }

  return {
    kind: 'educational_scenario',
    inputs: input,
    factors,
    simulation: { available: false, reason: SIMULATION_REASON },
    disclaimer: DISCLAIMER,
    limitations: [
      'Qualitative direction only; no spread rate, flame length, perimeter or arrival time is computed.',
      'Real fire behaviour also depends on fuel loading, fuel depth, temperature, recent weather, topography at fine scale and fire suppression.',
      'This laboratory does not use satellite detections and makes no claim about any observed fire.',
    ],
  };
}
