/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { History, Satellite } from 'lucide-react';
import { historyApi, type HistoryStatus, type HistoryYearResponse } from '../../api/history';

interface YearRow {
  year: number;
  modis: HistoryYearResponse | null;
  viirs: HistoryYearResponse | null;
}

/**
 * Yearly MODIS vs VIIRS totals from the local historical archive, restricted to
 * overlap years (both sensors present). VIIRS is Suomi-NPP only, so raw-count
 * ratios are context, never a harmonized measure.
 */
export const HistoricalOverlapTable: React.FC = () => {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [rows, setRows] = useState<YearRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const s = status ?? (await historyApi.status());
      setStatus(s);
      if (!s.available) {
        setError('Historical archive not available.');
        return;
      }
      const modisYears = new Set(s.sensors.MODIS?.years ?? []);
      const viirsYears = new Set(s.sensors.VIIRS?.years ?? []);
      const overlap = [...viirsYears].filter((y) => modisYears.has(y)).sort((a, b) => a - b);
      const out: YearRow[] = [];
      for (const year of overlap) {
        const [modis, viirs] = await Promise.all([
          historyApi.year('MODIS', year).catch(() => null),
          historyApi.year('VIIRS', year).catch(() => null),
        ]);
        out.push({ year, modis, viirs });
      }
      setRows(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load historical totals.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section aria-labelledby="hist-overlap-title" className="bg-surface border border-line rounded-card p-5 space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
          <History className="h-4 w-4 text-accent" aria-hidden="true" />
        </div>
        <div>
          <h3 id="hist-overlap-title" className="text-sm font-bold text-fg">Historical archive: MODIS vs VIIRS by year</h3>
          <p className="text-2xs text-fg-subtle">
            Local FIRMS archive · overlap years only · counts are satellite thermal anomalies, never summed
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ml-auto min-h-touch px-4 rounded-control bg-raised hover:bg-overlay text-fg text-xs font-medium border border-line transition-colors disabled:opacity-50"
        >
          {loading ? 'Loading…' : rows ? 'Reload' : 'Load historical totals'}
        </button>
      </div>

      {error && <p className="text-xs text-fg-muted">{error}</p>}

      {rows && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-fg-subtle text-2xs uppercase tracking-wider border-b border-line">
                <th className="py-2 pr-3 font-medium">Year</th>
                <th className="py-2 pr-3 font-medium">MODIS detections</th>
                <th className="py-2 pr-3 font-medium">VIIRS detections (S-NPP)</th>
                <th className="py-2 pr-3 font-medium">VIIRS:MODIS ratio</th>
                <th className="py-2 font-medium">Archive coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ratio =
                  r.modis && r.viirs && r.modis.detections > 0
                    ? (r.viirs.detections / r.modis.detections).toFixed(2)
                    : null;
                return (
                  <tr key={r.year} className="border-b border-line/50">
                    <td className="py-2 pr-3 font-mono numeric text-fg">{r.year}</td>
                    <td className="py-2 pr-3 numeric text-fg">
                      {r.modis ? r.modis.detections.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 pr-3 numeric text-fg">
                      {r.viirs ? r.viirs.detections.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 pr-3 numeric text-fg-muted">{ratio ?? '—'}</td>
                    <td className="py-2 text-2xs text-fg-subtle">
                      <span className="inline-flex items-center gap-1">
                        <Satellite className="h-3 w-3" aria-hidden="true" />
                        {r.modis?.days_with_data ?? 0} / {r.viirs?.days_with_data ?? 0} days with data
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-2xs text-fg-subtle mt-2">
            VIIRS is Suomi-NPP only in this archive; MODIS is Terra + Aqua. The ratio is a raw-count context
            figure, not a calibrated harmonization — VIIRS's finer resolution and different overpass times
            mean it naturally reports more detections.
          </p>
        </div>
      )}
    </section>
  );
};
