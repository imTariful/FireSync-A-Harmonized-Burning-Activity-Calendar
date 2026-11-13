import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, FiresResponse } from '../api/client';
import { CanonicalObservation, BoundingBox } from '../types/fire';
import { bboxToArea, dedupeById, shouldLoadViewport } from '../utils/geo';

export interface ViewportState {
  boxes: BoundingBox[];
  zoom: number;
  /** Stable key of `boxes`; changes only when the requested area really changes. */
  key: string;
}

export type FiresStatus = 'idle' | 'loading' | 'ready' | 'error';

/** When zoomed out, show a capped global sample instead of nothing (or of a fake archive). */
export const WORLD_OVERVIEW_CAP = 5000;

export interface ViewportFires {
  status: FiresStatus;
  /** Detections for the last successfully loaded viewport (or the capped world overview). */
  observations: CanonicalObservation[];
  counts: { MODIS: number; VIIRS: number };
  error: string | null;
  /** Non-fatal problems (one source or one half of an antimeridian view failed). */
  warnings: string[];
  truncated: boolean;
  /** ISO time of the oldest data used (server fetch time, kept when served from cache). */
  retrievedAt: string | null;
  cached: boolean;
  /** True when the current answer is a capped world overview, not a viewport query. */
  overview: boolean;
  /** True when the viewport is too wide / zoomed out to load a precise viewport query. */
  needsZoom: boolean;
  retry: () => void;
}

const EMPTY: CanonicalObservation[] = [];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Loads live FIRMS detections for the current viewport.
 * - zoomed in enough: a precise viewport query (antimeridian views use two requests)
 * - zoomed out / too wide: one capped `world` overview query, never a bundled archive
 * - the previous request is aborted whenever the viewport/days change (AbortController)
 */
export function useViewportFires(
  viewport: ViewportState | null,
  days: number,
  cap?: number
): ViewportFires {
  const loadable = viewport ? shouldLoadViewport(viewport.zoom, viewport.boxes) : false;
  const key = viewport?.key ?? '';
  const requestKey = loadable ? key : 'world-overview';

  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<FiresStatus>('idle');
  const [observations, setObservations] = useState<CanonicalObservation[]>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [overview, setOverview] = useState(false);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!viewport) {
      setStatus('idle');
      setObservations(EMPTY);
      setError(null);
      setWarnings([]);
      setTruncated(false);
      setRetrievedAt(null);
      setOverview(false);
      return;
    }

    const ac = new AbortController();
    setStatus('loading');
    setError(null);
    setOverview(!loadable);

    const requests = loadable
      ? viewport.boxes.map((b) => api.getFires({ area: bboxToArea(b), days, cap }, ac.signal))
      : [
          api.getFires(
            {
              area: 'world',
              days,
              cap: Math.min(cap ?? WORLD_OVERVIEW_CAP, WORLD_OVERVIEW_CAP),
            },
            ac.signal
          ),
        ];

    Promise.allSettled(requests).then((settled) => {
      if (ac.signal.aborted) return; // superseded by a newer viewport

      const ok: FiresResponse[] = [];
      const failures: string[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') ok.push(r.value);
        else failures.push(errorMessage(r.reason));
      }

      if (ok.length === 0) {
        setObservations(EMPTY);
        setError(failures[0] ?? 'Could not load fire data.');
        setWarnings([]);
        setStatus('error');
        return;
      }

      const notes: string[] = [];
      if (failures.length) notes.push(`Part of this view could not be loaded: ${failures[0]}`);
      for (const r of ok) if (r.errors.length) notes.push(`Some satellites did not answer: ${r.errors.join(' | ')}`);

      setObservations(dedupeById(ok.map((r) => r.observations)));
      setWarnings([...new Set(notes)]);
      setTruncated(ok.some((r) => r.truncated));
      setRetrievedAt(
        ok
          .map((r) => r.retrieved_at)
          .filter((t): t is string => Boolean(t))
          .sort()[0] ?? null
      );
      setCached(ok.every((r) => r.cached));
      setError(null);
      setStatus('ready');
    });

    return () => ac.abort();
    // `viewport` itself is represented by `requestKey` + `loadable`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, loadable, days, cap, nonce]);

  const counts = useMemo(() => {
    let MODIS = 0;
    let VIIRS = 0;
    for (const o of observations) {
      if (o.sensor === 'MODIS') MODIS++;
      else VIIRS++;
    }
    return { MODIS, VIIRS };
  }, [observations]);

  return {
    status,
    observations,
    counts,
    error,
    warnings,
    truncated,
    retrievedAt,
    cached,
    overview,
    needsZoom: false,
    retry,
  };
}
