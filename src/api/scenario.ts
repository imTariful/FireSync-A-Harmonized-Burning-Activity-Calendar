/**
 * Typed client for the Fire Behavior Scenario Laboratory.
 *
 * The assessment is deterministic and qualitative only; `simulation.available` is always false
 * because no validated fire-behaviour model is integrated. The AI explanation is optional text.
 */

export type ScenarioFuelType =
  | 'grass'
  | 'shrub'
  | 'timber_litter'
  | 'peat'
  | 'crop_residue'
  | 'mixed';

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
  simulation: { available: false; reason: string };
  disclaimer: string;
  limitations: string[];
}

export interface ScenarioAnalysisResponse {
  scenario: ScenarioInput;
  assessment: ScenarioAssessment;
  explanation: string | null;
  ai: { status: string; model: string | null; reason: string | null };
  guardrails: string[];
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export const scenarioApi = {
  analyze(input: ScenarioInput) {
    return req<ScenarioAnalysisResponse>('/api/v1/scenario/analyze', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
};
