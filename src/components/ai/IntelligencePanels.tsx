/**
 * Cluster investigation and scientific audit panels.
 *
 * Both panels are deterministic-first: the server computes the numbers, and Groq only adds an
 * optional narrative. When AI is off the panels keep working and show the reason.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Boxes, MapPin, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  intelligenceApi,
  type ClusterInvestigationResponse,
  type ClusterSummary,
  type AuditResponse,
} from '../../api/intelligence';
import { FIRE_LEGEND } from '../../types/ai';

interface Props {
  bbox: string;
  days: number;
}

export interface ClusterFocusTarget {
  latitude: number;
  longitude: number;
}

interface ClusterProps extends Props {
  onFocusCluster?: (target: ClusterFocusTarget) => void;
}

function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'The request failed.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

function AiNote({ ai }: { ai: { status: string; reason: string | null } }) {
  if (!ai.reason) return null;
  return (
    <p className="text-2xs text-fg-subtle flex items-start gap-1.5">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{ai.reason}</span>
    </p>
  );
}

export interface ClusterInvestigationContentProps {
  data: ClusterInvestigationResponse | null;
  error: string | null;
  loading: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onFocusCluster?: (target: ClusterFocusTarget) => void;
}

const ClusterDetails: React.FC<{
  cluster: ClusterSummary;
  report: string | null;
  ai: ClusterInvestigationResponse['ai'];
  onFocusCluster?: (target: ClusterFocusTarget) => void;
}> = ({ cluster, report, ai, onFocusCluster }) => {
  const confidence = cluster.mean_confidence === null ? 'not available' : cluster.mean_confidence;

  return (
    <div data-testid="cluster-card" className="rounded-card border border-line bg-canvas p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-2xs font-mono uppercase text-fg-subtle">Candidate hotspot group</p>
          <h4 className="text-sm font-bold text-fg">{cluster.id}</h4>
        </div>
        <span className="badge badge-warn text-2xs">not a confirmed fire</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-2xs">
        <div>
          <span className="text-fg-subtle font-mono uppercase">MODIS detections</span>
          <div data-testid="cluster-modis-count" className="text-fg font-mono">
            {cluster.by_sensor.MODIS.toLocaleString()}
          </div>
        </div>
        <div>
          <span className="text-fg-subtle font-mono uppercase">VIIRS detections</span>
          <div data-testid="cluster-viirs-count" className="text-fg font-mono">
            {cluster.by_sensor.VIIRS.toLocaleString()}
          </div>
        </div>
        <div>
          <span className="text-fg-subtle font-mono uppercase">First detection (UTC)</span>
          <div className="text-fg font-mono break-words">{cluster.first_detection_utc}</div>
        </div>
        <div>
          <span className="text-fg-subtle font-mono uppercase">Last detection (UTC)</span>
          <div className="text-fg font-mono break-words">{cluster.last_detection_utc}</div>
        </div>
        <div>
          <span className="text-fg-subtle font-mono uppercase">Duration</span>
          <div className="text-fg font-mono">{`${cluster.duration_hours} h`}</div>
        </div>
        <div>
          <span className="text-fg-subtle font-mono uppercase">Active days</span>
          <div className="text-fg font-mono">{cluster.active_days}</div>
        </div>
        <div>
          <span className="text-fg-subtle font-mono uppercase">Active 1 km cells (any sensor)</span>
          <div className="text-fg font-mono">{cluster.active_1km_cells.toLocaleString()}</div>
        </div>
        <div>
          <span className="text-fg-subtle font-mono uppercase">Confidence summary (derived)</span>
          <div className="text-fg font-mono">{confidence}</div>
        </div>
      </div>

      <p className="text-2xs text-fg-subtle">
        Centroid {cluster.centroid.latitude}, {cluster.centroid.longitude} · bbox {cluster.bbox.west},{' '}
        {cluster.bbox.south}, {cluster.bbox.east}, {cluster.bbox.north}
      </p>
      <p className="text-2xs text-fg-subtle">
        Satellites: {cluster.satellites.join(', ') || 'no observation record'}
      </p>

      <div className="grid grid-cols-2 gap-2 text-2xs">
        <div className="rounded-control border border-line bg-surface px-2 py-1.5">
          <span className="text-fg-subtle font-mono uppercase">MODIS FRP total</span>
          <div data-testid="cluster-frp-modis" className="text-fg font-mono">
            {`${cluster.frp_mw.MODIS} MW`}
          </div>
        </div>
        <div className="rounded-control border border-line bg-surface px-2 py-1.5">
          <span className="text-fg-subtle font-mono uppercase">VIIRS FRP total</span>
          <div data-testid="cluster-frp-viirs" className="text-fg font-mono">
            {`${cluster.frp_mw.VIIRS} MW`}
          </div>
        </div>
      </div>
      <p className="text-2xs text-fg-subtle">
        FRP totals stay separate per sensor. No combined fire-energy or fire-count figure is shown.
      </p>
      <p className="text-2xs text-fg-subtle">
        The confidence summary is a derived index: numeric MODIS confidence is averaged, and VIIRS
        low/nominal/high categories are mapped to 20/50/80. It is not a NASA numeric VIIRS confidence.
      </p>

      {onFocusCluster && (
        <button
          type="button"
          onClick={() => onFocusCluster(cluster.centroid)}
          aria-label={`Focus candidate group ${cluster.id} on the map`}
          className="inline-flex min-h-touch items-center gap-1.5 rounded-control border border-line px-2.5 py-1.5 text-2xs font-semibold text-fg-muted hover:bg-raised"
        >
          <MapPin className="h-3.5 w-3.5" aria-hidden="true" /> Focus on map
        </button>
      )}

      {report ? (
        <div className="rounded-control bg-surface border border-line p-2.5">
          <p className="text-2xs font-mono uppercase text-fg-subtle mb-1">AI investigation report</p>
          <p className="text-xs text-fg-muted leading-relaxed whitespace-pre-line">{report}</p>
        </div>
      ) : (
        <p className="text-2xs text-fg-subtle flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{`AI report unavailable: ${
            ai.reason ??
            (ai.status === 'enabled'
              ? 'The AI provider returned no report.'
              : 'AI is not enabled on this server.')
          }`}</span>
        </p>
      )}

      {cluster.notes.length > 0 && (
        <ul className="space-y-1">
          {cluster.notes.map((note) => (
            <li key={note} className="text-2xs text-fg-subtle">
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const ClusterInvestigationContent: React.FC<ClusterInvestigationContentProps> = ({
  data,
  error,
  loading,
  selectedId,
  onSelect,
  onRetry,
  onFocusCluster,
}) => {
  const cluster = data?.cluster ?? null;
  const options = data
    ? cluster && !data.clusters.some((c) => c.id === cluster.id)
      ? [cluster, ...data.clusters]
      : data.clusters
    : [];
  const selectedValue = selectedId || cluster?.id || '';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Boxes className="h-4 w-4 text-accent" aria-hidden="true" />
        <h3 className="text-xs font-bold text-fg">Fire Event Detective</h3>
      </div>
      <p className="text-2xs text-fg-subtle">
        Candidate hotspot groups from spatial-temporal single-linkage clustering. A group is not a
        confirmed wildfire or a fire perimeter.
      </p>

      {loading && (
        <p role="status" className="text-2xs text-fg-subtle inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Clustering detections…
        </p>
      )}

      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-2xs text-danger">
            {error}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-touch items-center gap-1.5 rounded-control border border-line px-2.5 py-1.5 text-2xs font-semibold text-fg-muted hover:bg-raised"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry cluster investigation
          </button>
        </div>
      )}

      {!loading && !error && !data && (
        <p className="text-2xs text-fg-subtle">No cluster investigation result was returned.</p>
      )}

      {data && !loading && !error && (
        <>
          <p className="text-2xs text-fg-muted">
            {data.total_clusters.toLocaleString()} candidate group(s) ·{' '}
            {data.analysed_detections.toLocaleString()} analysed input records (both sensors; not a
            fire count) · {data.window.start_date} to {data.window.end_date} · bbox {data.area.bbox} ·
            sensors {data.sensors}
            {data.total_clusters > data.clusters.length
              ? ` · showing the largest ${data.clusters.length}`
              : ''}
          </p>

          {data.notes.length > 0 && (
            <ul className="space-y-1">
              {data.notes.map((note) => (
                <li key={note} className="text-2xs text-fg-subtle">
                  {note}
                </li>
              ))}
            </ul>
          )}

          {options.length > 1 && (
            <label className="block text-2xs text-fg-subtle" htmlFor="cluster-select">
              Investigate candidate group
              <select
                id="cluster-select"
                value={selectedValue}
                onChange={(event) => onSelect(event.target.value)}
                className="mt-1 w-full rounded-control border border-line bg-canvas px-2 py-1.5 text-xs text-fg"
              >
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · MODIS {c.by_sensor.MODIS} · VIIRS {c.by_sensor.VIIRS} ·{' '}
                    {c.first_detection_utc.slice(0, 16)}Z
                  </option>
                ))}
              </select>
            </label>
          )}

          {cluster ? (
            <ClusterDetails
              cluster={cluster}
              report={data.report}
              ai={data.ai}
              onFocusCluster={onFocusCluster}
            />
          ) : (
            <p
              role="status"
              className="rounded-control border border-warning/40 bg-canvas px-3 py-2 text-xs text-warning"
            >
              {data.analysed_detections === 0
                ? 'No detections were available in this window, so no candidate group can be formed. This is an empty result, not zero fire.'
                : 'No candidate group was returned for this window.'}
            </p>
          )}

          <p className="text-2xs text-fg-subtle font-mono">
            Source: {data.source.data_source} · provenance {data.source.provenance_status}
            {data.source.retrieved_at ? ` · retrieved ${data.source.retrieved_at}` : ''}
            {data.source.truncated ? ' · capped, counts are lower bounds' : ''}
          </p>
          {data.source.source_errors.length > 0 && (
            <ul className="space-y-1">
              {data.source.source_errors.map((sourceError) => (
                <li key={sourceError} className="text-2xs text-warning">
                  {sourceError}
                </li>
              ))}
            </ul>
          )}
          <p className="text-2xs text-fg-subtle">{FIRE_LEGEND}</p>
        </>
      )}
    </div>
  );
};

export const ClusterInvestigator: React.FC<ClusterProps> = ({ bbox, days, onFocusCluster }) => {
  const [selected, setSelected] = useState<string>('');
  const load = useCallback(
    () => intelligenceApi.clusterInvestigation(bbox, days, selected ? { cluster_id: selected } : {}),
    [bbox, days, selected]
  );
  const { data, error, loading, reload } = useLoad<ClusterInvestigationResponse>(load, [bbox, days, selected]);

  return (
    <ClusterInvestigationContent
      data={data}
      error={error}
      loading={loading}
      selectedId={selected}
      onSelect={setSelected}
      onRetry={() => {
        setSelected('');
        reload();
      }}
      onFocusCluster={onFocusCluster}
    />
  );
};

export const AuditDashboard: React.FC<Props> = ({ bbox, days }) => {
  const load = useCallback(() => intelligenceApi.scientificAudit(bbox, days), [bbox, days]);
  const { data, error, loading } = useLoad<AuditResponse>(load, [bbox, days]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" />
        <h3 className="text-xs font-bold text-fg">Scientific integrity audit</h3>
      </div>

      {loading && (
        <p className="text-2xs text-fg-subtle inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Auditing records…
        </p>
      )}
      {error && (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      )}

      {data && (
        <>
          <p className="text-2xs text-fg-muted">
            {data.audit.checked_records.toLocaleString()} records · {data.audit.summary.pass} pass ·{' '}
            {data.audit.summary.warn} warn · {data.audit.summary.fail} fail · status{' '}
            <span className="font-mono">{data.audit.scientific_status}</span>
          </p>
          <ul className="space-y-1.5">
            {data.audit.checks.map((check) => (
              <li key={check.id} className="rounded-control border border-line bg-canvas p-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`badge text-2xs font-mono ${
                      check.status === 'pass'
                        ? 'badge-info'
                        : check.status === 'fail'
                          ? 'badge-danger'
                          : 'badge-warn'
                    }`}
                  >
                    {check.status}
                  </span>
                  <span className="text-2xs font-semibold text-fg">{check.label}</span>
                </div>
                <p className="text-2xs text-fg-subtle mt-1">{check.detail}</p>
              </li>
            ))}
          </ul>
          {data.summary_text ? (
            <div className="rounded-control bg-surface border border-line p-2.5">
              <p className="text-2xs font-mono uppercase text-fg-subtle mb-1">AI summary</p>
              <p className="text-xs text-fg-muted leading-relaxed whitespace-pre-line">{data.summary_text}</p>
            </div>
          ) : (
            <AiNote ai={data.ai} />
          )}
        </>
      )}
    </div>
  );
};
