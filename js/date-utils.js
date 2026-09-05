export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function localMonthKey(date = new Date()) {
  return localDateKey(date).slice(0, 7);
}

export function isValidDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return false;
  const [year, month, day] = dateKey.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

export function dayOfDateKey(dateKey) {
  if (!isValidDateKey(dateKey)) return -1;
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}

export function expectedMeetingTypeForDate(dateKey) {
  const day = dayOfDateKey(dateKey);
  if (day === 0) return '주일말씀';
  if (day === 3) return '수요말씀';
  return '';
}

export function formatKoreanDate(dateKey) {
  if (!isValidDateKey(dateKey)) return String(dateKey || '');
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${year}. ${month}. ${day}.`;
}

export function shiftMonthKey(monthKey, offset) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return '';
  const [year, month] = monthKey.split('-').map(Number);
  const shifted = new Date(year, month - 1 + offset, 1);
  return `${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}`;
}

export function monthBounds(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return null;
  return { start: `${monthKey}-01`, end: `${shiftMonthKey(monthKey, 1)}-01` };
}

export function recentMonthKeys(count = 36, anchor = new Date()) {
  const current = localMonthKey(anchor);
  return Array.from({ length: count }, (_, index) => shiftMonthKey(current, -index));
}

export function datesInMonthByWeekday(monthKey, weekday) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return [];
  const [year, month] = monthKey.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const dates = [];
  for (let day = 1; day <= lastDay; day += 1) {
    const dateKey = `${year}-${pad2(month)}-${pad2(day)}`;
    if (dayOfDateKey(dateKey) === weekday) dates.push(dateKey);
  }
  return dates;
}
