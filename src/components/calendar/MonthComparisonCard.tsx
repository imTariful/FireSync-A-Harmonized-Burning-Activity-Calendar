import React, { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import { DailyActivitySummary } from '../../types/fire';
import { compareMonthToHistory } from '../../utils/calendarStats';
import { todayUtc } from '../../utils/filterValidation';

interface MonthComparisonCardProps {
  dailySummaries: DailyActivitySummary[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "This month so far vs the same days in other years" for the selected area (harmonized activity). */
export const MonthComparisonCard: React.FC<MonthComparisonCardProps> = ({ dailySummaries }) => {
  const today = todayUtc();
  const c = useMemo(() => compareMonthToHistory(dailySummaries, today), [dailySummaries, today]);
  const window = `${MONTHS[c.month - 1]} 1–${c.throughDay}`;

  let headline: string;
  let detail: string;
  if (c.status === 'insufficient_history') {
    headline = 'Not enough history to compare';
    detail = `${window}: ${c.current} harmonized units so far. A median needs at least 3 other years of ${MONTHS[c.month - 1]} in the selected range; only ${c.yearsUsed} found.`;
  } else if (c.pctVsMedian === null) {
    headline = `${c.current} units vs a median of ${c.historicalMedian}`;
    detail = `${window}, compared with the same days in ${c.yearsUsed} other years. The median is 0, so no percentage is shown.`;
  } else {
    const dir = c.pctVsMedian > 0 ? 'above' : c.pctVsMedian < 0 ? 'below' : 'at';
    headline = c.pctVsMedian === 0 ? 'At the historical median' : `${Math.abs(c.pctVsMedian)}% ${dir} the historical median`;
    detail = `${window}: ${c.current} harmonized units vs a median of ${c.historicalMedian} for the same days in ${c.yearsUsed} other years.`;
  }

  return (
    <section aria-labelledby="month-compare-title" className="bg-surface border border-line rounded-card p-4 space-y-2">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-accent" aria-hidden="true" />
        <h3 id="month-compare-title" className="text-sm font-semibold text-fg">This month vs history</h3>
      </div>
      <p className="text-base font-semibold text-fg numeric">{headline}</p>
      <p className="text-xs text-fg-muted">{detail}</p>
      <p className="text-2xs text-fg-subtle">
        Only days with observation records contribute. Missing dates are not treated as zero fire, so a month-to-date
        sum can undercount when overpasses or records are absent.
      </p>
    </section>
  );
};
