import React, { useMemo } from 'react';
import { DailyActivitySummary } from '../../types/fire';
import { buildMonthYearMatrix, monthKey, RAMP, rampStep, textOnStep } from '../../utils/calendarStats';
import { todayUtc } from '../../utils/filterValidation';

interface MonthYearHeatmapProps {
  dailySummaries: DailyActivitySummary[];
  onSelectYear?: (year: number) => void;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmt = (v: number) => (v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1));

/**
 * Year x month overview: which months and years had the most burning activity.
 * Colour = harmonized activity (BAU), a viridis ramp (colour-blind safe). The value is also written in
 * every cell, so colour is never the only carrier of meaning. MODIS and VIIRS counts stay separate in the tooltip.
 */
export const MonthYearHeatmap: React.FC<MonthYearHeatmapProps> = ({ dailySummaries, onSelectYear }) => {
  const today = todayUtc();
  const matrix = useMemo(() => buildMonthYearMatrix(dailySummaries, today), [dailySummaries, today]);
  const todayYear = Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7));

  if (matrix.years.length === 0) {
    return (
      <section className="bg-surface border border-line rounded-card p-4 text-sm text-fg-muted">
        No data in the selected range.
      </section>
    );
  }

  const legend = [0, 1, 2, 3, 4].map((i) => ({
    color: RAMP[i],
    label: `${fmt((matrix.max * i) / 5)}–${fmt((matrix.max * (i + 1)) / 5)}`,
  }));

  return (
    <section aria-labelledby="heatmap-title" className="bg-surface border border-line rounded-card p-4 space-y-3">
      <div>
        <h3 id="heatmap-title" className="text-sm font-semibold text-fg">Burning activity by month and year</h3>
        <p className="text-xs text-fg-muted">
          Harmonized activity (BAU, 1-km equivalent) summed over observed days. Empty cell = no observation record for
          that month, which is not zero fire.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-2xs numeric min-w-[34rem]">
          <caption className="sr-only">Harmonized fire activity per month for each year</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left text-fg-muted font-medium w-12">Year</th>
              {MONTH_LABELS.map((m) => (
                <th key={m} scope="col" className="text-fg-muted font-medium">{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.years.map((year) => (
              <tr key={year}>
                <th scope="row" className="text-left font-medium">
                  {onSelectYear ? (
                    <button
                      type="button"
                      onClick={() => onSelectYear(year)}
                      className="min-h-touch text-accent hover:underline focus-visible:outline-accent"
                    >
                      {year}
                    </button>
                  ) : (
                    year
                  )}
                </th>
                {MONTH_LABELS.map((_, i) => {
                  const month = i + 1;
                  const future = year > todayYear || (year === todayYear && month > todayMonth);
                  if (future) {
                    return <td key={month} className="h-9 rounded-control bg-canvas" aria-label={`${MONTH_LABELS[i]} ${year}: not yet`} />;
                  }
                  const cell = matrix.cells.get(monthKey(year, month));
                  const value = cell?.harmonized ?? 0;
                  const step = rampStep(value, matrix.max);
                  const title = cell
                    ? `${MONTH_LABELS[i]} ${year}: ${fmt(value)} harmonized units · MODIS ${cell.modis} · VIIRS ${cell.viirs} · ${cell.activeDays} active days`
                    : `${MONTH_LABELS[i]} ${year}: no observation record (not zero fire)`;
                  return (
                    <td
                      key={month}
                      title={title}
                      aria-label={title}
                      className={`h-9 rounded-control text-center font-medium ${step === 0 ? 'bg-raised text-fg-subtle' : ''}`}
                      style={
                        step === 0
                          ? undefined
                          : { backgroundColor: RAMP[step - 1], color: textOnStep(step) === 'dark' ? '#0b0e14' : '#ffffff' }
                      }
                    >
                      {step === 0 ? '–' : fmt(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-muted" aria-label="Colour legend">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-5 rounded-sm bg-raised border border-line" aria-hidden="true" /> none
        </span>
        {legend.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5 numeric">
            <span className="inline-block h-3 w-5 rounded-sm" style={{ backgroundColor: l.color }} aria-hidden="true" />
            {l.label}
          </span>
        ))}
      </div>
    </section>
  );
};
