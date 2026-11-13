/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Archive, Satellite } from 'lucide-react';
import { historyApi, type HistoryStatus, type HistoryYearResponse } from '../../api/history';

/**
 * Historical archive year summary for the Overview page.
 * Numbers come straight from the local FIRMS archive API; MODIS and VIIRS are
 * always shown separately and never summed.
 */
export const HistoricalArchivePanel: React.FC = () => {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [totals, setTotals] = useState<Record<string, HistoryYearResponse | null>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    historyApi
      .status()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (!s.available) return;
        const years = new Set<number>();
        for (const sensor of Object.values(s.sensors)) for (const y of sensor.years) years.add(y);
        const sorted = [...years].sort((a, b) => a - b);
        // Default to the latest year where BOTH sensors overlap, else latest year.
        const overlap = sorted.filter((y) =>
          (s.sensors.MODIS?.years.includes(y) ?? false) && (s.sensors.VIIRS?.years.includes(y) ?? false)
        );
        setYear(overlap.length ? overlap[overlap.length - 1] : sorted[sorted.length - 1] ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatusError(e instanceof Error ? e.message : 'Historical archive unavailable.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sensors = useMemo(() => {
    if (!status) return [] as Array<'MODIS' | 'VIIRS'>;
    const out: Array<'MODIS' | 'VIIRS'> = [];
    if (status.sensors.MODIS) out.push('MODIS');
    if (status.sensors.VIIRS) out.push('VIIRS');
    return out;
  }, [status]);

  useEffect(() => {
    if (year == null) return;
    let cancelled = false;
    setLoading(true);
    Promise.all(
      sensors.map((sensor) =>
        historyApi
          .year(sensor, year)
          .then((t) => ({ sensor, t }))
          .catch(() => ({ sensor, t: null }))
      )
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, HistoryYearResponse | null> = {};
      for (const r of results) next[r.sensor] = r.t;
      setTotals(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [year, sensors]);

  const allYears = useMemo(() => {
    if (!status) return [] as number[];
    const set = new Set<number>();
    for (const s of Object.values(status.sensors)) for (const y of s.years) set.add(y);
    return [...set].sort((a, b) => a - b);
  }, [status]);

  if (statusError) {
    return (
      <section className="bg-surface border border-line rounded-card p-4">
        <p className="text-xs text-fg-muted">Historical archive status unavailable: {statusError}</p>
      </section>
    );
  }
  if (!status) return null;
  if (!status.available) {
    return (
      <section className="bg-surface border border-line rounded-card p-4">
        <p className="text-xs text-fg-muted">No local historical archive found at {status.root}.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="hist-archive-title" className="bg-surface border border-line rounded-card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
          <Archive className="h-4 w-4 text-accent" aria-hidden="true" />
        </div>
        <h3 id="hist-archive-title" className="text-sm font-semibold text-fg">Local historical archive</h3>
        <span className="text-2xs text-fg-subtle">FIRMS ZIPs 2000–2025 · MODIS &amp; VIIRS kept separate</span>
        <label className="ml-auto flex items-center gap-1.5 text-2xs text-fg-muted">
          Year
          <select
            value={year ?? ''}
            onChange={(e) => setYear(Number(e.target.value))}
            className="bg-raised border border-line rounded-control px-2 py-1 text-xs text-fg numeric"
            aria-label="Historical year"
          >
            {allYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p className="text-xs text-fg-muted">Loading archive totals…</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {sensors.map((sensor) => {
          const t = totals[sensor];
          const meta = status.sensors[sensor];
          return (
            <div key={sensor} className="bg-raised border border-line rounded-control p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                <Satellite className="h-3.5 w-3.5" aria-hidden="true" />
                {sensor}
                <span className="text-2xs font-normal text-fg-subtle">
                  {sensor === 'VIIRS' ? 'Suomi-NPP only' : 'Terra + Aqua'}
                </span>
              </div>
              {t ? (
                <>
                  <div className="text-xl font-bold text-fg numeric">{t.detections.toLocaleString()}</div>
                  <div className="text-2xs text-fg-muted numeric">
                    detections · {t.days_with_data} days with data
                    {t.frp_sum_mw != null ? ` · ${(t.frp_sum_mw / 1e6).toFixed(1)}M MW total FRP` : ''}
                  </div>
                </>
              ) : (
                <div className="text-2xs text-fg-muted">
                  {meta?.years.includes(year ?? -1)
                    ? 'No rows returned for this year.'
                    : `${sensor} archive does not cover ${year} (available ${meta?.years[0]}–${meta?.years[meta.years.length - 1]}).`}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-2xs text-fg-subtle">
        Satellite thermal anomalies, not confirmed wildfires or burned area. VIIRS coverage starts 2012-01-20;
        MODIS-only years are expected before that. Export:{' '}
        <a
          className="text-accent hover:underline"
          href={`/api/v1/history/export/daily.csv?year=${year ?? ''}&global=true`}
          download
        >
          daily CSV
        </a>
        {' · '}
        <a className="text-accent hover:underline" href="/api/v1/history/export/coverage.csv" download>
          coverage CSV
        </a>
      </p>
    </section>
  );
};
