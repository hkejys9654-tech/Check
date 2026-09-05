import { isValidDateKey } from './date-utils.js';

export function pendingWriteKey(district, date, type) {
  return `${district}|${date}|${type}`;
}

export function readPendingWrites(storage, storageKey) {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getPendingWrite(storage, storageKey, district, date, type) {
  return readPendingWrites(storage, storageKey)[pendingWriteKey(district, date, type)] || null;
}

export function setPendingWrite(storage, storageKey, entry) {
  const pending = readPendingWrites(storage, storageKey);
  pending[pendingWriteKey(entry.district, entry.date, entry.type)] = {
    ...entry,
    queuedAt: entry.queuedAt || Date.now(),
  };
  storage.setItem(storageKey, JSON.stringify(pending));
}

export function clearPendingWrite(storage, storageKey, district, date, type) {
  const pending = readPendingWrites(storage, storageKey);
  const key = pendingWriteKey(district, date, type);
  if (!pending[key]) return;
  delete pending[key];
  storage.setItem(storageKey, JSON.stringify(pending));
}

export function applyPendingWrites(recordsByDistrict, district, pending) {
  const records = recordsByDistrict[district] || (recordsByDistrict[district] = {});
  Object.values(pending || {}).forEach((entry) => {
    if (!entry || entry.district !== district || !isValidDateKey(entry.date) || !entry.type) return;
    if (entry.op === 'delete') {
      if (records[entry.date]) {
        delete records[entry.date][entry.type];
        if (Object.keys(records[entry.date]).length === 0) delete records[entry.date];
      }
      return;
    }
    if (!records[entry.date]) records[entry.date] = {};
    records[entry.date][entry.type] = Array.isArray(entry.record) ? [...entry.record] : [];
  });
  return recordsByDistrict;
}
