/**
 * Sensor Conflict Investigator.
 *
 * Deterministic MODIS vs VIIRS comparison from `/api/v1/ai/sensor-explanation`. The server
 * computes every number; Groq only adds an optional narrative. The two sensors are rendered
 * separately and are never added into a combined fire count.
 */

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import {
  intelligenceApi,
  type SensorExplanationResponse,
  type SensorStats,
} from '../../api/intelligence';
import { FIRE_LEGEND } from '../../types/ai';

interface PanelProps {
  bbox: string;
  days: number;
}

export interface SensorConflictContentProps {
  data: SensorExplanationResponse | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}

function valueOrUnknown(value: number | null): string {
  return value === null ? 'not available' : value.toLocaleString();
}

function peakHours(stats: SensorStats): string {
  if (stats.peak_hours_utc.length === 0) return 'no observation record';
  return stats.peak_hours_utc.map((entry) => `${entry.hour_utc}:00 UTC (${entry.count})`).join(', ');
}

function satellites(stats: SensorStats): string {
  return stats.satellites.length === 0 ? 'no observation record' : stats.satellites.join(', ');
}

const SensorRow: React.FC<{ sensor: 'MODIS' | 'VIIRS'; stats: SensorStats }> = ({ sensor, stats }) => (
  <tr data-testid={`sensor-${sensor.toLowerCase()}`}>
    <th scope="row" className="py-1.5 text-left font-semibold text-fg">
      {sensor}
    </th>
    <td className="text-right font-mono">{stats.detections.toLocaleString()}</td>
    <td className="text-right font-mono">{stats.frp_total_mw.toLocaleString()}</td>
    <td className="text-right font-mono">{valueOrUnknown(stats.frp_mean_mw)}</td>
    <td className="text-right font-mono">{valueOrUnknown(stats.mean_confidence)}</td>
    <td className="pl-3 font-mono">{peakHours(stats)}</td>
    <td className="pl-3 font-mono">{satellites(stats)}</td>
  </tr>
);

export const SensorConflictContent: React.FC<SensorConflictContentProps> = ({
  data,
  error,
  loading,
  onRetry,
}) => {
  if (loading) {
    return (
      <p role="status" className="text-2xs text-fg-subtle inline-flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Comparing MODIS and VIIRS…
      </p>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-control border border-line px-2.5 py-1.5 text-2xs font-semibold text-fg-muted hover:bg-raised"
        >
          Retry sensor comparison
        </button>
      </div>
    );
  }

  if (!data) {
    return <p className="text-2xs text-fg-subtle">No sensor comparison was returned.</p>;
  }

  const { comparison, ai, source, notes } = data;
  const empty = comparison.MODIS.detections === 0 && comparison.VIIRS.detections === 0;
  const aiText = ai.status === 'enabled' ? data.explanation : null;
  const aiUnavailableReason =
    ai.reason ??
    (ai.status === 'enabled'
      ? 'The AI provider returned no explanation.'
      : 'AI is not enabled on this server.');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" />
        <h3 className="text-xs font-bold text-fg">MODIS vs VIIRS</h3>
      </div>
      <p className="text-2xs text-fg-subtle">
        {comparison.window.start_date} to {comparison.window.end_date} · bbox {comparison.bbox} · both
        sensors are loaded for this comparison; the map sensor filter is not applied.
      </p>

      {empty && (
        <p role="status" className="rounded-control border border-warning/40 bg-canvas px-3 py-2 text-xs text-warning">
          No detections in this window. This is missing coverage, not zero fire.
        </p>
      )}

      {!empty && (
        <div className="overflow-x-auto">
          <table className="w-full text-2xs">
            <caption className="sr-only">
              MODIS and VIIRS comparison, reported separately and never summed
            </caption>
            <thead className="text-fg-subtle font-mono uppercase">
              <tr>
                <th scope="col" className="text-left py-1">
                  Sensor
                </th>
                <th scope="col" className="text-right">
                  Detections
                </th>
                <th scope="col" className="text-right">
                  FRP total (MW)
                </th>
                <th scope="col" className="text-right">
                  FRP mean (MW)
                </th>
                <th scope="col" className="text-right">
                  Mean confidence
                </th>
                <th scope="col" className="text-left pl-3">
                  Peak UTC hours
                </th>
                <th scope="col" className="text-left pl-3">
                  Satellites
                </th>
              </tr>
            </thead>
            <tbody className="text-fg-muted">
              <SensorRow sensor="MODIS" stats={comparison.MODIS} />
              <SensorRow sensor="VIIRS" stats={comparison.VIIRS} />
            </tbody>
          </table>
        </div>
      )}

      <p className="text-2xs text-fg-subtle">
        Confidence is the server&apos;s numeric summary only. VIIRS confidence can be categorical, so
        a numeric mean is not directly comparable to MODIS.
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="sensor-cells">
        <div className="rounded-control border border-line bg-canvas px-2 py-1.5">
          <p className="text-2xs text-fg-subtle">Paired 1 km cells</p>
          <p className="text-xs font-mono text-fg">{comparison.cells.paired.toLocaleString()}</p>
        </div>
        <div className="rounded-control border border-line bg-canvas px-2 py-1.5">
          <p className="text-2xs text-fg-subtle">MODIS-only 1 km cells</p>
          <p className="text-xs font-mono text-fg">{comparison.cells.modis_only.toLocaleString()}</p>
        </div>
        <div className="rounded-control border border-line bg-canvas px-2 py-1.5">
          <p className="text-2xs text-fg-subtle">VIIRS-only 1 km cells</p>
          <p className="text-xs font-mono text-fg">{comparison.cells.viirs_only.toLocaleString()}</p>
        </div>
      </div>
      <p className="text-2xs text-fg-subtle">{comparison.sensor_only_note}</p>

      {aiText ? (
        <div className="rounded-card border border-accent/30 bg-accent/5 px-3 py-2">
          <p className="text-2xs font-semibold text-accent">AI explanation</p>
          <p className="text-xs text-fg whitespace-pre-line">{aiText}</p>
        </div>
      ) : (
        <p className="text-2xs text-fg-subtle flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{`AI explanation unavailable: ${aiUnavailableReason}`}</span>
        </p>
      )}

      {notes.length > 0 && (
        <ul className="space-y-1">
          {notes.map((note) => (
            <li key={note} className="text-2xs text-fg-subtle">
              {note}
            </li>
          ))}
        </ul>
      )}

      <p className="text-2xs text-fg-subtle font-mono">
        Source: {source.data_source} · provenance {source.provenance_status}
        {source.retrieved_at ? ` · retrieved ${source.retrieved_at}` : ''}
        {source.truncated ? ' · capped, counts are lower bounds' : ''}
      </p>
      {source.source_errors.length > 0 && (
        <ul className="space-y-1">
          {source.source_errors.map((sourceError) => (
            <li key={sourceError} className="text-2xs text-warning">
              {sourceError}
            </li>
          ))}
        </ul>
      )}
      <p className="text-2xs text-fg-subtle">{FIRE_LEGEND}</p>
    </div>
  );
};

export const SensorConflictPanel: React.FC<PanelProps> = ({ bbox, days }) => {
  const [data, setData] = useState<SensorExplanationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    intelligenceApi
      .sensorExplanation(bbox, days)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'The sensor comparison failed.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bbox, days, nonce]);

  return (
    <SensorConflictContent
      data={data}
      error={error}
      loading={loading}
      onRetry={() => setNonce((value) => value + 1)}
    />
  );
};
