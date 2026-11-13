/**
 * Scenario Laboratory tab of the AI Investigator.
 *
 * Educational interface for hypothetical wind, fuel, humidity, slope and fuel-moisture
 * conditions. The deterministic server assessment is qualitative only; quantitative fire-spread
 * simulation is explicitly unavailable because no validated fire-behaviour model is integrated.
 */

import React, { useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import {
  scenarioApi,
  type ScenarioAnalysisResponse,
  type ScenarioFuelType,
} from '../../api/scenario';

const inputCls =
  'w-full rounded-control border border-line bg-canvas px-2 py-1.5 text-xs text-fg placeholder:text-fg-subtle';

const DIRECTION_STYLE: Record<string, string> = {
  favors_spread: 'text-danger',
  limits_spread: 'text-accent',
  context_dependent: 'text-warning',
  neutral: 'text-fg-subtle',
};

export const ScenarioPanel: React.FC = () => {
  const [windSpeed, setWindSpeed] = useState('20');
  const [windDirection, setWindDirection] = useState('');
  const [humidity, setHumidity] = useState('40');
  const [fuel, setFuel] = useState<ScenarioFuelType>('grass');
  const [slope, setSlope] = useState('');
  const [moisture, setMoisture] = useState('');
  const [result, setResult] = useState<ScenarioAnalysisResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await scenarioApi.analyze({
        wind_speed_kmh: Number(windSpeed),
        relative_humidity_pct: Number(humidity),
        fuel,
        ...(windDirection.trim() !== '' ? { wind_direction_deg: Number(windDirection) } : {}),
        ...(slope.trim() !== '' ? { slope_degrees: Number(slope) } : {}),
        ...(moisture.trim() !== '' ? { fuel_moisture_pct: Number(moisture) } : {}),
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The scenario could not be evaluated.');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-control border border-warning/50 bg-canvas p-2.5 space-y-1">
        <p className="text-2xs font-semibold text-warning">Simulation unavailable</p>
        <p className="text-2xs text-fg-subtle leading-relaxed">
          This laboratory explains qualitative fire-behaviour context only. No spread rate, perimeter or arrival
          time is computed — that requires a validated specialist fire-behaviour model that is not integrated.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">
          Hypothetical conditions
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-2xs text-fg-subtle">
            Wind speed km/h
            <input
              className={`${inputCls} mt-0.5`}
              type="number"
              min={0}
              max={200}
              value={windSpeed}
              onChange={(e) => setWindSpeed(e.target.value)}
            />
          </label>
          <label className="text-2xs text-fg-subtle">
            Wind direction ° (optional)
            <input
              className={`${inputCls} mt-0.5`}
              type="number"
              min={0}
              max={360}
              placeholder="e.g. 270"
              value={windDirection}
              onChange={(e) => setWindDirection(e.target.value)}
            />
          </label>
          <label className="text-2xs text-fg-subtle">
            Relative humidity %
            <input
              className={`${inputCls} mt-0.5`}
              type="number"
              min={0}
              max={100}
              value={humidity}
              onChange={(e) => setHumidity(e.target.value)}
            />
          </label>
          <label className="text-2xs text-fg-subtle">
            Fuel type
            <select
              className={`${inputCls} mt-0.5`}
              value={fuel}
              onChange={(e) => setFuel(e.target.value as ScenarioFuelType)}
            >
              <option value="grass">Grass</option>
              <option value="shrub">Shrub</option>
              <option value="timber_litter">Timber &amp; litter</option>
              <option value="peat">Peat</option>
              <option value="crop_residue">Crop residue</option>
              <option value="mixed">Mixed</option>
            </select>
          </label>
          <label className="text-2xs text-fg-subtle">
            Slope ° (optional)
            <input
              className={`${inputCls} mt-0.5`}
              type="number"
              min={0}
              max={60}
              placeholder="e.g. 15"
              value={slope}
              onChange={(e) => setSlope(e.target.value)}
            />
          </label>
          <label className="text-2xs text-fg-subtle">
            Fuel moisture % (optional)
            <input
              className={`${inputCls} mt-0.5`}
              type="number"
              min={0}
              max={60}
              placeholder="e.g. 8"
              value={moisture}
              onChange={(e) => setMoisture(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="btn btn-secondary text-xs gap-1.5 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
          Evaluate scenario
        </button>
      </section>

      {error && (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      )}

      {result && (
        <section className="space-y-2">
          <h3 className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">
            Qualitative assessment
          </h3>
          <ul className="space-y-1.5">
            {result.assessment.factors.map((factor) => (
              <li key={factor.factor} className="rounded-control border border-line bg-canvas p-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xs font-semibold text-fg capitalize">
                    {factor.factor.replace(/_/g, ' ')}
                  </span>
                  <span className="text-2xs text-fg-subtle">{factor.category}</span>
                  <span className={`text-2xs ml-auto ${DIRECTION_STYLE[factor.direction] ?? 'text-fg-subtle'}`}>
                    {factor.direction.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="text-2xs text-fg-muted mt-1 leading-relaxed">{factor.note}</p>
              </li>
            ))}
          </ul>
          <p className="text-2xs text-fg-subtle leading-relaxed">{result.assessment.disclaimer}</p>
          <ul className="list-disc pl-4 space-y-0.5">
            {result.assessment.limitations.map((limitation) => (
              <li key={limitation} className="text-2xs text-fg-subtle">
                {limitation}
              </li>
            ))}
          </ul>
          {result.explanation ? (
            <p className="text-2xs text-fg-muted leading-relaxed border-t border-line pt-1.5">
              {result.explanation}
            </p>
          ) : (
            <p className="text-2xs text-fg-subtle border-t border-line pt-1.5">
              AI explanation unavailable{result.ai.reason ? `: ${result.ai.reason}` : '.'}
            </p>
          )}
        </section>
      )}
    </div>
  );
};
