import { useCallback, useEffect, useMemo, useState } from 'react';
import { historyApi } from '../api/history';
import { CanonicalObservation, BoundingBox } from '../types/fire';
import { dedupeById } from '../utils/geo';
import type { ViewportState } from './useViewportFires';

export interface HistoricalFires {
  status: 'idle' | 'loading' | 'ready' | 'error';
  observations: CanonicalObservation[];
  counts: { MODIS: number; VIIRS: number };
  error: string | null;
  truncated: boolean;
  retry: () => void;
}

const EMPTY: CanonicalObservation[] = [];

function bboxParam(b: BoundingBox): string {
  return `${b.west},${b.south},${b.east},${b.north}`;
}

/**
 * Loads historical archive detections for ONE date and the current viewport.
 * Unlike the live hook there is no day window and no world-overview fallback:
 * an absent archive day simply returns zero rows (reported honestly by the UI).
 */
export function useHistoricalFires(
  viewport: ViewportState | null,
  date: string | null,
  cap?: number
): HistoricalFires {
  const key = viewport?.key ?? '';
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<HistoricalFires['status']>('idle');
  const [observations, setObservations] = useState<CanonicalObservation[]>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!viewport || !date) {
      setStatus('idle');
      setObservations(EMPTY);
      setError(null);
      setTruncated(false);
      return;
    }
    const ac = new AbortController();
    // historyApi does not take a signal; guard with the aborted flag instead.
    let aborted = false;
    setStatus('loading');
    setError(null);

    const limit = Math.min(cap ?? 20000, 50000);
    Promise.all(
      viewport.boxes.map((b) =>
        historyApi.observations({ date, bbox: bboxParam(b), limit }).catch((e) => {
          throw e;
        })
      )
    )
      .then((results) => {
        if (aborted || ac.signal.aborted) return;
        setObservations(dedupeById(results.map((r) => r.rows)));
        setTruncated(results.some((r) => r.truncated));
        setStatus('ready');
      })
      .catch((e) => {
        if (aborted || ac.signal.aborted) return;
        setObservations(EMPTY);
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });

    return () => {
      aborted = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, date, cap, nonce]);

  const counts = useMemo(() => {
    let MODIS = 0;
    let VIIRS = 0;
    for (const o of observations) {
      if (o.sensor === 'MODIS') MODIS++;
      else VIIRS++;
    }
    return { MODIS, VIIRS };
  }, [observations]);

  return { status, observations, counts, error, truncated, retry };
}
