/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarRange, Info } from 'lucide-react';
import { historyApi, type HistoryClimatologyResponse } from '../../api/history';
import type { ActivityClass } from '../../utils/seasonalClimatology';

const CLASS_STYLE: Record<ActivityClass, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-sky-500/15', text: 'text-sky-300', label: 'Low' },
  typical: { bg: 'bg-emerald-500/15', text: 'text-emerald-300', label: 'Typical' },
  elevated: { bg: 'bg-amber-500/20', text: 'text-amber-300', label: 'Elevated' },
  high: { bg: 'bg-danger/20', text: 'text-danger', label: 'High' },
  unavailable: { bg: 'bg-gray-500/15', text: 'text-gray-400', label: 'No data' },
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Seasonal burning outlook: per-month historical climatology for a country.
 * Everything shown is "what was typical in 2000-2025" — explicitly NOT a forecast.
 */
export const SeasonalOutlookPanel: React.FC = () => {
  const [country, setCountry] = useState('Australia');
  const [input, setInput] = useState('Australia');
  const [countries, setCountries] = useState<string[]>([]);
  const [data, setData] = useState<HistoryClimatologyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    historyApi
      .countries()
      .then((r) => setCountries(r.rows))
      .catch(() => setCountries([]));
  }, []);

  useEffect(() => {
    if (!country.trim()) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    historyApi
      .climatology({ country: country.trim() })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setData(null);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [country]);

  const maxMedian = useMemo(
    () => Math.max(0, ...(data?.months.map((m) => m.harmonized_equivalent_median ?? 0) ?? [])),
    [data]
  );

  return (
    <section aria-labelledby="seasonal-outlook-title" className="bg-surface border border-line rounded-card p-5 space-y-4 shadow-elev-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-control bg-raised border border-line flex items-center justify-center shrink-0">
            <CalendarRange className="h-4 w-4 text-accent" aria-hidden="true" />
          </div>
          <div>
            <h3 id="seasonal-outlook-title" className="font-bold text-fg text-sm">Seasonal burning outlook</h3>
            <p className="text-2xs text-fg-muted">
              Historical climatology 2000–2025 — typical activity per month, not a forecast.
            </p>
          </div>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setCountry(input.trim());
          }}
        >
          <input
            list="seasonal-countries"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Country (e.g. Australia)"
            className="bg-raised border border-line rounded-control px-2.5 py-1.5 text-xs text-fg w-44"
            aria-label="Country for seasonal outlook"
          />
          <datalist id="seasonal-countries">
            {countries.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <button
            type="submit"
            className="min-h-touch px-3 rounded-control bg-accent hover:bg-accent-hover text-accent-fg text-xs font-semibold transition-colors"
          >
            Apply
          </button>
        </form>
      </div>

      {loading && <p className="text-xs text-fg-muted">Computing climatology…</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {data && !loading && (
        <div className="space-y-3">
          <div className="grid grid-cols-12 gap-1.5">
            {data.months.map((m) => {
              const style = CLASS_STYLE[m.activity_class];
              const intensity = maxMedian > 0 ? Math.min(1, (m.harmonized_equivalent_median ?? 0) / maxMedian) : 0;
              return (
                <div
                  key={m.month}
                  className={`rounded-control border border-line p-2 text-center ${style.bg}`}
                  title={`Month ${m.month}: ${style.label} — harmonized-equivalent median ${m.harmonized_equivalent_median?.toLocaleString() ?? 'n/a'} (EXPLORATORY)`}
                >
                  <div className="text-2xs font-mono text-fg-subtle">{MONTH_NAMES[m.month - 1]}</div>
                  <div className={`text-2xs font-bold ${style.text}`}>{style.label}</div>
                  <div className="mt-1 h-1 rounded-full bg-overlay overflow-hidden">
                    <div className={`h-full ${style.text.replace('text-', 'bg-')}`} style={{ width: `${Math.round(intensity * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-4 text-2xs text-fg-muted">
            <span>
              Peak months:{' '}
              <strong className="text-fg">
                {data.season.peak_months.map((m) => MONTH_NAMES[m - 1]).join(', ') || 'none'}
              </strong>
            </span>
            <span>
              Lowest months:{' '}
              <strong className="text-fg">
                {data.season.low_months.map((m) => MONTH_NAMES[m - 1]).join(', ') || 'none'}
              </strong>
            </span>
            <span>
              Archive years: <strong className="text-fg">{data.year_range ? `${data.year_range.start}–${data.year_range.end}` : 'n/a'}</strong>
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-2xs">
              <thead>
                <tr className="text-fg-subtle text-left border-b border-line">
                  <th className="py-1 pr-3 font-medium">Month</th>
                  <th className="py-1 pr-3 font-medium">MODIS median</th>
                  <th className="py-1 pr-3 font-medium">VIIRS median</th>
                  <th className="py-1 pr-3 font-medium">Harmonized equiv. (EXPLORATORY)</th>
                  <th className="py-1 font-medium">Class</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr key={m.month} className="border-b border-line/50">
                    <td className="py-1 pr-3 text-fg">{MONTH_NAMES[m.month - 1]}</td>
                    <td className="py-1 pr-3 text-fg-muted numeric">{m.sensors.MODIS?.median_detections.toLocaleString() ?? '—'}</td>
                    <td className="py-1 pr-3 text-fg-muted numeric">{m.sensors.VIIRS?.median_detections.toLocaleString() ?? '—'}</td>
                    <td className="py-1 pr-3 text-fg-muted numeric">{m.harmonized_equivalent_median?.toLocaleString() ?? '—'}</td>
                    <td className={`py-1 font-semibold ${CLASS_STYLE[m.activity_class].text}`}>{CLASS_STYLE[m.activity_class].label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-2xs text-fg-subtle flex items-start gap-1.5">
            <Info className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{data.notes[0]} The harmonized-equivalent column uses the fixed 0.294 exploratory coefficient — not a validated calibration. {data.legend}</span>
          </p>
        </div>
      )}
    </section>
  );
};
