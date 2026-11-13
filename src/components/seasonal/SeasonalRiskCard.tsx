/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { TrendingUp, Info } from 'lucide-react';
import { historyApi, type HistorySeasonalStatusResponse } from '../../api/history';
import type { ActivityClass } from '../../utils/seasonalClimatology';

const CLASS_STYLE: Record<ActivityClass, string> = {
  low: 'text-sky-300',
  typical: 'text-emerald-300',
  elevated: 'text-amber-300',
  high: 'text-danger',
  unavailable: 'text-gray-400',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Compact seasonal-risk card: where the current day-of-year sits in the country's
 * historical distribution, and which calendar months are typically most active.
 * Climatology only — explicitly not a fire forecast.
 */
export const SeasonalRiskCard: React.FC = () => {
  const [country, setCountry] = useState('Australia');
  const [countries, setCountries] = useState<string[]>([]);
  const [data, setData] = useState<HistorySeasonalStatusResponse | null>(null);
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
      .seasonalStatus({ country: country.trim() })
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

  return (
    <section aria-labelledby="seasonal-risk-title" className="bg-surface border border-line rounded-card p-4 space-y-3 shadow-elev-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-accent" aria-hidden="true" />
          <h3 id="seasonal-risk-title" className="text-sm font-bold text-fg">Seasonal risk (climatology)</h3>
        </div>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="bg-raised border border-line rounded-control px-2 py-1 text-2xs text-fg"
          aria-label="Country for seasonal risk"
        >
          {(countries.includes(country) ? countries : [country, ...countries]).slice(0, 80).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="text-2xs text-fg-muted">Loading seasonal status…</p>}
      {error && (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      )}

      {data && !loading && (
        <div className="space-y-2.5">
          <p className="text-2xs text-fg-muted">
            <strong className="text-fg">{data.country}</strong> · {data.date} (day {data.day_of_year}) · ±{Math.floor(data.window_days / 2)}-day window vs {data.today_window.MODIS?.years_total ?? data.today_window.VIIRS?.years_total ?? '?'} archive years
          </p>

          <div className="grid grid-cols-2 gap-2">
            {(['MODIS', 'VIIRS'] as const).map((s) => {
              const w = data.today_window[s];
              if (!w) return null;
              return (
                <div key={s} className="bg-raised border border-line rounded-control p-2.5">
                  <div className="text-2xs font-mono text-fg-subtle uppercase">{s} typical range</div>
                  <div className="text-sm font-bold text-fg numeric mt-0.5">
                    {w.p25_detections.toLocaleString()} – {w.p75_detections.toLocaleString()}
                  </div>
                  <div className="text-2xs text-fg-muted numeric">
                    median {w.median_detections.toLocaleString()} · {w.years_with_data}/{w.years_total} yrs
                  </div>
                </div>
              );
            })}
          </div>

          <div className="text-2xs">
            <span className="text-fg-subtle">Next months: </span>
            {data.upcoming_months.map((u) => (
              <span key={u.month} className={`font-semibold ${CLASS_STYLE[u.activity_class]}`}>
                {MONTH_NAMES[u.month - 1]} {u.activity_class}
                {u !== data.upcoming_months[data.upcoming_months.length - 1] ? ' · ' : ''}
              </span>
            ))}
          </div>

          <p className="text-2xs text-fg-subtle flex items-start gap-1.5">
            <Info className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
            Historical climatology only — typical ranges and seasonal classes, not a fire forecast or confirmed activity. MODIS and VIIRS stay separate.
          </p>
        </div>
      )}
    </section>
  );
};
