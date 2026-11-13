/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Globe2 } from 'lucide-react';
import { historyApi, type HistoryCountryTotal, type HistoryRankingsResponse, type HistoryStatus } from '../../api/history';

/**
 * Historical archive country rankings for one year. MODIS and VIIRS are shown in
 * separate ranked lists and never combined into one score.
 */
export const HistoricalCountryRankings: React.FC = () => {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [data, setData] = useState<HistoryRankingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    historyApi
      .status()
      .then((s) => {
        setStatus(s);
        if (!s.available) return;
        const years = new Set<number>();
        for (const sensor of Object.values(s.sensors)) for (const y of sensor.years) years.add(y);
        const sorted = [...years].sort((a, b) => a - b);
        setYear(sorted[sorted.length - 1] ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Archive status unavailable.'));
  }, []);

  useEffect(() => {
    if (year == null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    historyApi
      .rankings(year)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Rankings request failed.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  const top = useMemo(() => {
    if (!data) return { MODIS: [] as HistoryCountryTotal[], VIIRS: [] as HistoryCountryTotal[] };
    const take = (sensor: string) => data.rows.filter((r: HistoryCountryTotal) => r.sensor === sensor).slice(0, 10);
    return { MODIS: take('MODIS'), VIIRS: take('VIIRS') };
  }, [data]);

  const allYears = useMemo(() => {
    if (!status) return [] as number[];
    const set = new Set<number>();
    for (const s of Object.values(status.sensors)) for (const y of s.years) set.add(y);
    return [...set].sort((a, b) => a - b);
  }, [status]);

  if (!status?.available) return null;

  return (
    <section aria-labelledby="hist-rankings-title" className="bg-surface border border-line rounded-card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
          <Globe2 className="h-4 w-4 text-accent" aria-hidden="true" />
        </div>
        <h3 id="hist-rankings-title" className="text-sm font-bold text-fg">Historical archive: countries by detections</h3>
        <label className="ml-auto flex items-center gap-1.5 text-2xs text-fg-muted">
          Year
          <select
            value={year ?? ''}
            onChange={(e) => setYear(Number(e.target.value))}
            className="bg-raised border border-line rounded-control px-2 py-1 text-xs text-fg numeric"
            aria-label="Ranking year"
          >
            {allYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p className="text-xs text-fg-muted">Loading archive rankings…</p>}
      {error && <p className="text-xs text-fg-muted">{error}</p>}

      {data && !loading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(['MODIS', 'VIIRS'] as const).map((sensor) => (
            <div key={sensor} className="bg-canvas border border-line rounded-control overflow-hidden">
              <div className="px-3 py-2 border-b border-line text-2xs font-mono uppercase tracking-wider text-fg-subtle">
                {sensor}
                {sensor === 'VIIRS' ? ' · Suomi-NPP only' : ''} — top 10 countries, {data.year}
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {top[sensor].length === 0 && (
                    <tr>
                      <td className="px-3 py-3 text-fg-subtle">No archive rows for this sensor-year.</td>
                    </tr>
                  )}
                  {top[sensor].map((r, i) => (
                    <tr key={r.country} className="border-t border-line/50 first:border-0">
                      <td className="px-3 py-1.5 text-fg-subtle numeric w-8">{i + 1}</td>
                      <td className="px-3 py-1.5 text-fg font-medium">{r.country}</td>
                      <td className="px-3 py-1.5 text-right numeric text-fg">{r.detections.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right numeric text-fg-subtle text-2xs">
                        {r.frp_sum_mw != null ? `${(r.frp_sum_mw / 1e6).toFixed(1)}M MW` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      <p className="text-2xs text-fg-subtle">
        {data?.note ?? 'Country labels come from the source archive filenames.'} Satellite thermal anomalies, not
        confirmed wildfires or burned area. Rankings are per sensor and never combined.
      </p>
    </section>
  );
};
