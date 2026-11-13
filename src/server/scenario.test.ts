/**
 * Scenario Laboratory tests.
 *
 * The laboratory is educational and qualitative only. These tests pin input validation bounds
 * and the guarantee that the assessment never produces quantitative fire-spread output and
 * always reports simulation as unavailable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScenarioAssessment,
  parseScenarioRequest,
  SCENARIO_FUEL_TYPES,
  type ScenarioInput,
} from './scenario';

const VALID: ScenarioInput = {
  wind_speed_kmh: 20,
  relative_humidity_pct: 35,
  fuel: 'grass',
};

test('parseScenarioRequest accepts a minimal valid scenario', () => {
  const parsed = parseScenarioRequest({
    wind_speed_kmh: 20,
    relative_humidity_pct: 35,
    fuel: 'grass',
  });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, VALID);
});

test('parseScenarioRequest accepts every fuel type and optional fields', () => {
  for (const fuel of SCENARIO_FUEL_TYPES) {
    const parsed = parseScenarioRequest({
      wind_speed_kmh: 0,
      relative_humidity_pct: 100,
      fuel,
      wind_direction_deg: 270,
      slope_degrees: 15,
      fuel_moisture_pct: 10,
    });
    assert.ok(parsed.ok, `fuel ${fuel} should parse`);
  }
});

test('parseScenarioRequest rejects non-object bodies', () => {
  for (const body of [null, undefined, 'x', 42, []]) {
    const parsed = parseScenarioRequest(body);
    assert.equal(parsed.ok, false);
  }
});

test('parseScenarioRequest rejects missing or out-of-range required fields', () => {
  assert.equal(parseScenarioRequest({ relative_humidity_pct: 50, fuel: 'grass' }).ok, false);
  assert.equal(parseScenarioRequest({ wind_speed_kmh: 20, fuel: 'grass' }).ok, false);
  assert.equal(parseScenarioRequest({ wind_speed_kmh: -1, relative_humidity_pct: 50, fuel: 'grass' }).ok, false);
  assert.equal(parseScenarioRequest({ wind_speed_kmh: 201, relative_humidity_pct: 50, fuel: 'grass' }).ok, false);
  assert.equal(parseScenarioRequest({ wind_speed_kmh: 20, relative_humidity_pct: 101, fuel: 'grass' }).ok, false);
  assert.equal(parseScenarioRequest({ wind_speed_kmh: 20, relative_humidity_pct: -5, fuel: 'grass' }).ok, false);
  assert.equal(parseScenarioRequest({ wind_speed_kmh: 'fast', relative_humidity_pct: 50, fuel: 'grass' }).ok, false);
});

test('parseScenarioRequest rejects unknown fuel types', () => {
  const parsed = parseScenarioRequest({
    wind_speed_kmh: 20,
    relative_humidity_pct: 50,
    fuel: 'uranium',
  });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /fuel must be one of/);
});

test('parseScenarioRequest validates optional field bounds and ignores blanks', () => {
  const base = { wind_speed_kmh: 20, relative_humidity_pct: 50, fuel: 'shrub' };
  assert.equal(parseScenarioRequest({ ...base, wind_direction_deg: 361 }).ok, false);
  assert.equal(parseScenarioRequest({ ...base, wind_direction_deg: -1 }).ok, false);
  assert.equal(parseScenarioRequest({ ...base, slope_degrees: 61 }).ok, false);
  assert.equal(parseScenarioRequest({ ...base, fuel_moisture_pct: 61 }).ok, false);
  const parsed = parseScenarioRequest({ ...base, wind_direction_deg: '', slope_degrees: null });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.wind_direction_deg, undefined);
  assert.equal(parsed.value.slope_degrees, undefined);
});

test('assessment always reports simulation unavailable with a reason', () => {
  const assessment = buildScenarioAssessment(VALID);
  assert.equal(assessment.kind, 'educational_scenario');
  assert.equal(assessment.simulation.available, false);
  assert.ok(assessment.simulation.reason.length > 0);
});

test('assessment produces only qualitative factors and never quantitative spread output', () => {
  const assessment = buildScenarioAssessment({
    ...VALID,
    wind_direction_deg: 180,
    slope_degrees: 25,
    fuel_moisture_pct: 8,
  });
  assert.deepEqual(
    assessment.factors.map((f) => f.factor),
    ['wind', 'relative_humidity', 'fuel', 'wind_direction', 'slope', 'fuel_moisture']
  );
  const serialized = JSON.stringify(assessment);
  // No numeric forecast fields may appear anywhere in the assessment.
  for (const forbidden of ['rate_of_spread', 'spread_rate', 'perimeter', 'arrival_time', 'flame_length']) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `assessment must not contain ${forbidden}`);
  }
  for (const factor of assessment.factors) {
    assert.ok(['favors_spread', 'limits_spread', 'context_dependent', 'neutral'].includes(factor.direction));
    assert.ok(factor.note.length > 0);
  }
});

test('wind, humidity, slope and moisture categories respond to their thresholds', () => {
  const factorFor = (input: Partial<ScenarioInput>) => {
    const assessment = buildScenarioAssessment({ ...VALID, ...input });
    return Object.fromEntries(assessment.factors.map((f) => [f.factor, f.category]));
  };
  assert.equal(factorFor({ wind_speed_kmh: 5 }).wind, 'low');
  assert.equal(factorFor({ wind_speed_kmh: 20 }).wind, 'moderate');
  assert.equal(factorFor({ wind_speed_kmh: 50 }).wind, 'high');
  assert.equal(factorFor({ relative_humidity_pct: 10 }).relative_humidity, 'very dry');
  assert.equal(factorFor({ relative_humidity_pct: 70 }).relative_humidity, 'humid');
  assert.equal(factorFor({ slope_degrees: 5 }).slope, 'gentle');
  assert.equal(factorFor({ slope_degrees: 15 }).slope, 'moderate');
  assert.equal(factorFor({ slope_degrees: 30 }).slope, 'steep');
  assert.equal(factorFor({ fuel_moisture_pct: 4 }).fuel_moisture, 'very dry');
  assert.equal(factorFor({ fuel_moisture_pct: 30 }).fuel_moisture, 'wet');
});

test('assessment echoes the validated inputs and lists limitations', () => {
  const assessment = buildScenarioAssessment(VALID);
  assert.deepEqual(assessment.inputs, VALID);
  assert.ok(assessment.disclaimer.length > 0);
  assert.ok(assessment.limitations.length >= 3);
});
