/**
 * Evidence card for one satellite detection.
 *
 * The card renders the record's real fields (coordinates, time, sensor, satellite, confidence,
 * FRP, brightness, product, provenance). The AI explanation is text only: it never replaces or
 * invents a field, and fields the record does not carry are shown as "not provided".
 */

import React from 'react';
import { Satellite, Thermometer, MapPin, Clock, ShieldQuestion } from 'lucide-react';
import type { CanonicalObservation } from '../../types/fire';
import type { AiDetectionExplanationResponse } from '../../types/ai';
import { aiApi } from '../../api/ai';

interface Props {
  observation: CanonicalObservation | null;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-canvas border border-line rounded-control p-2.5">
      <div className="text-fg-subtle text-2xs font-mono uppercase tracking-wider">{label}</div>
      <div className="text-xs font-mono text-fg mt-0.5 break-words">{value}</div>
    </div>
  );
}

export const DetectionEvidenceCard: React.FC<Props> = ({ observation }) => {
  const [state, setState] = React.useState<{
    loading: boolean;
    error: string | null;
    result: AiDetectionExplanationResponse | null;
  }>({ loading: false, error: null, result: null });

  React.useEffect(() => {
    setState({ loading: false, error: null, result: null });
  }, [observation?.id]);

  if (!observation) {
    return (
      <div className="rounded-card border border-line bg-canvas p-4 text-xs text-fg-muted">
        No detection selected. Load detections on the map, then pick one here to inspect its record.
      </div>
    );
  }

  const explain = async () => {
    setState({ loading: true, error: null, result: null });
    try {
      const result = await aiApi.explainDetection(observation);
      setState({ loading: false, error: null, result });
    } catch (err) {
      setState({
        loading: false,
        error: err instanceof Error ? err.message : 'The explanation could not be generated.',
        result: null,
      });
    }
  };

  const brightness =
    observation.brightness ?? observation.bright_ti4 ?? observation.bright_ti5 ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="badge badge-info text-2xs font-mono">{observation.sensor}</span>
        <span className="text-xs font-semibold text-fg">{observation.satellite}</span>
        <span className="text-2xs text-fg-subtle font-mono">{observation.product}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Location"
          value={
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {observation.latitude.toFixed(4)}, {observation.longitude.toFixed(4)}
            </span>
          }
        />
        <Field
          label="Acquired (UTC)"
          value={
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {observation.datetime_utc}
            </span>
          }
        />
        <Field
          label="FRP"
          value={
            <span className="inline-flex items-center gap-1">
              <Thermometer className="h-3 w-3" aria-hidden="true" />
              {observation.frp_mw} MW
            </span>
          }
        />
        <Field label="Confidence" value={String(observation.confidence)} />
        <Field label="Brightness" value={brightness === null ? 'not provided' : `${brightness} K`} />
        <Field label="Pixel (scan × track)" value={`${observation.scan} × ${observation.track} km`} />
        <Field
          label="Day / night"
          value={observation.daynight === 'D' ? 'Day' : observation.daynight === 'N' ? 'Night' : 'not provided'}
        />
        <Field
          label="Provenance"
          value={
            <span className="inline-flex items-center gap-1">
              <Satellite className="h-3 w-3" aria-hidden="true" />
              {observation.provenance_status ?? 'UNVERIFIED'}
            </span>
          }
        />
      </div>

      <p className="text-2xs text-fg-subtle leading-relaxed">
        These fields are the observation record itself. Satellite thermal anomalies, not confirmed wildfires or
        burned area.
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={explain}
          disabled={state.loading}
          className="btn btn-secondary text-xs disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {state.loading ? 'Explaining…' : 'Explain this detection with AI'}
        </button>
        {state.result && (
          <span className="text-2xs text-fg-subtle font-mono">model: {state.result.model}</span>
        )}
      </div>

      {state.error && (
        <div role="alert" className="rounded-control border border-danger/60 bg-canvas p-3 text-xs text-danger">
          {state.error}
        </div>
      )}

      {state.result && (
        <div className="rounded-card border border-line bg-canvas p-3.5 space-y-2">
          <div className="flex items-center gap-1.5 text-2xs font-mono uppercase tracking-wider text-fg-subtle">
            <ShieldQuestion className="h-3.5 w-3.5" aria-hidden="true" />
            AI explanation
          </div>
          <p className="text-xs text-fg-muted leading-relaxed whitespace-pre-line">{state.result.explanation}</p>
          {state.result.fields_missing.length > 0 && (
            <p className="text-2xs text-fg-subtle">
              Not in this record: {state.result.fields_missing.join(', ')}.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
