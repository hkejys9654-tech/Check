import { datesInMonthByWeekday } from './date-utils.js';

export function safeRate(numerator, denominator) {
  return denominator ? Math.round((Number(numerator || 0) / Number(denominator)) * 100) : 0;
}

export function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

export function scheduledMeetingCounts(monthKey, excludedDates = new Map()) {
  const isExcluded = (date) => excludedDates?.has?.(date);
  return {
    주일말씀: datesInMonthByWeekday(monthKey, 0).filter((date) => !isExcluded(date)).length,
    수요말씀: datesInMonthByWeekday(monthKey, 3).filter((date) => !isExcluded(date)).length,
    구역모임: 1,
  };
}

export function expectedSubmissionCount({ rows, type, monthKey, districtCount, excludedDates }) {
  if (/^\d{4}-\d{2}$/.test(String(monthKey || ''))) {
    const scheduled = scheduledMeetingCounts(monthKey, excludedDates);
    return (scheduled[type] || 0) * districtCount;
  }

  const dates = new Set(
    (rows || [])
      .filter((row) => row?.모임 === type && !excludedDates?.has?.(row?.날짜))
      .map((row) => row.날짜),
  );
  return dates.size * districtCount;
}

export function perSubmissionAverage(total, submissionCount) {
  return submissionCount ? Number(total || 0) / submissionCount : 0;
}
