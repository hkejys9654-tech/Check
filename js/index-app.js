import { ALL_DISTRICTS, CATEGORIES, CAT_ORDER } from './config.js';
import { expectedMeetingTypeForDate, formatKoreanDate, isValidDateKey, localDateKey } from './date-utils.js';
import {
  ensureMemberId,
  legacyMemberId,
  normalizeName,
  normalizeRosterMembers,
  recordHasPerson,
  removePersonFromRecord,
  togglePersonInRecord,
} from './data-model.js';
import {
  deleteAttendance,
  getDistrictRecords,
  getGlobalNotice,
  getMonthlyActivity,
  getRoster,
  saveMonthlyActivity as saveMonthlyActivityRemote,
  saveRoster,
  submitAttendance,
} from './firebase-store.js';
import {
  applyPendingWrites,
  clearPendingWrite,
  getPendingWrite,
  readPendingWrites,
  setPendingWrite,
} from './sync-queue.js';
import { escapeAttribute, escapeHtml as escapeHtmlValue, installAccessibleModals } from './ui-utils.js';

// 기존 앱 함수들의 호출부를 단계적으로 유지하면서 Firebase 초기화는
// 이 모듈의 import 완료 뒤에만 가능하도록 한곳에서 연결한다.
Object.assign(window, {
  submitAttendanceToFirebase: submitAttendance,
  deleteAttendanceFromFirebase: deleteAttendance,
  getGlobalNoticeFromFirebase: getGlobalNotice,
  getDistrictRecordsFromFirebase: getDistrictRecords,
  getRosterFromFirebase: getRoster,
  saveRosterFromFirebase: saveRoster,
  getMonthlyActivityFromFirebase: getMonthlyActivity,
  saveMonthlyActivityToFirebase: saveMonthlyActivityRemote,
});

const STORAGE_KEY_MEMBERS = 'guAttendance_members_v2';
const STORAGE_KEY_RECORDS = 'guAttendance_records_v2';
const STORAGE_KEY_LASTDISTRICT = 'guAttendance_lastDistrict';
const STORAGE_KEY_PRAYERS = 'guPrayerList_v1';
const STORAGE_KEY_PRAYER_DISTRICT = 'guPrayer_lastDistrict';
const STORAGE_KEY_VOLUNTEER_DISTRICT = 'guVolunteer_lastDistrict';
const STORAGE_KEY_UPDATE_NOTICE = 'guAttendance_updateNotice';
const STORAGE_KEY_GLOBAL_NOTICE = 'guAttendance_globalNoticeSeen';
const STORAGE_KEY_SERVER_SYNCED_DISTRICTS = 'guAttendance_serverSyncedDistricts_v1';
const STORAGE_KEY_PENDING_ATTENDANCE = 'guAttendance_pendingServerWrites_v1';
const STORAGE_KEY_VOLUNTEER_STATE = 'guVolunteer_state_v1';
const APP_VERSION = '2026.09.05-reliability-modules';
const SILENT_UPDATE_VERSION = '2026.06.11-admin-auto-sync-save-all-merge';
const TYPE_CLASS = { 주일말씀: 'sunday', 수요말씀: 'wednesday', 구역모임: 'gathering' };
const TYPE_BG = { 주일말씀: '#fdedec', 수요말씀: '#f5eef8', 구역모임: '#eef5fc' };
const TYPE_COLOR = { 주일말씀: '#c0392b', 수요말씀: '#8e44ad', 구역모임: '#4A90E2' };
const VOLUNTEER_DAYS = [
  { date: '8/6', dow: '목', slots: [{ c: 'E', t: '선발대', mark: true }] },
  {
    date: '8/7',
    dow: '금',
    slots: [
      { c: 'F', t: '본대', mark: true },
      { c: 'G', t: '09~12', f: 'morning' },
      { c: 'H', t: '12~15', f: 'afternoon' },
      { c: 'I', t: '15~18', f: 'afternoon' },
      { c: 'J', t: '18~21', f: 'afternoon' },
      { c: 'K', t: '21~24', f: 'night' },
    ],
  },
  {
    date: '8/8',
    dow: '토',
    slots: [
      { c: 'L', t: '06~09', f: 'morning' },
      { c: 'M', t: '09~12', f: 'morning' },
      { c: 'N', t: '12~15', f: 'afternoon' },
      { c: 'O', t: '15~18', f: 'afternoon' },
      { c: 'P', t: '18~21', f: 'afternoon' },
      { c: 'Q', t: '21~24', f: 'night' },
    ],
  },
  {
    date: '8/9',
    dow: '일',
    slots: [
      { c: 'R', t: '06~09', f: 'morning' },
      { c: 'S', t: '09~12', f: 'morning' },
      { c: 'T', t: '12~15', f: 'afternoon' },
      { c: 'U', t: '15~18', f: 'afternoon' },
      { c: 'V', t: '18~21', f: 'afternoon' },
      { c: 'W', t: '21~24', f: 'night' },
    ],
  },
  { date: '8/10', dow: '월', slots: [{ c: 'X', t: '06~12', f: 'morning' }] },
];
const VOLUNTEER_VEHICLES = [
  {
    title: '개인 차량',
    items: [
      { c: 'Y', t: '갈 때' },
      { c: 'Z', t: '올 때' },
    ],
  },
  {
    title: '교회 차량',
    items: [
      { c: 'AA', t: '갈 때' },
      { c: 'AB', t: '올 때' },
    ],
  },
];
const VOLUNTEER_FILL = { morning: 'FF92D050', afternoon: 'FFFFC000', night: 'FFF8F7F3' };

let allMembersData = {};
let allAttendanceRecords = {};
let allPrayerData = {};
let allRosterData = {};
let workingRecord = [];
let isDirty = false;
let lastGeneratedImageBlob = null;
let lastGeneratedImageFilename = '';
let prayerImageFiles = [];
let lastPrayerImageDistrict = '';
let volunteerState = { roster: [], form: newVolunteerForm() };
let volunteerUiReady = false;
let currentStatsType = '주일말씀';
let currentStatsMonth = 'all';
let previousMeetingType = '주일말씀';
let currentPersonalCat = 'EUN';
let currentPersonalType = '주일말씀';
let currentPersonalMonth = 'all';
let currentMonthlyActivity = null;

const elDistrict = document.getElementById('district-select');
const elDate = document.getElementById('date-select');
const elType = document.getElementById('meeting-type');
const elAttendance = document.getElementById('attendance-content');
const elPrayerDistrict = document.getElementById('prayer-district-select');
const elPrayerImageDistrict = document.getElementById('prayer-image-district-select');
const elVolunteerSection = document.getElementById('volunteer-section');
const elVolunteerDistrict = document.getElementById('volunteer-district');
const elVolunteerName = document.getElementById('volunteer-name');
const elVolunteerPhone = document.getElementById('volunteer-phone');
const elSetupDistrictLabel = document.getElementById('setup-district-label');
const elSaveIndicator = document.getElementById('save-indicator');
const elBtnSaveRecord = document.getElementById('btn-save-record');
const elRecordStatusWrap = document.getElementById('record-status-wrap');
const elMonthlyActivityCard = document.getElementById('monthly-activity-card');

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

const lazyScriptPromises = {};

function loadScriptWhenNeeded(key, src, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (lazyScriptPromises[key]) return lazyScriptPromises[key];

  lazyScriptPromises[key] = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      if (!globalName || window[globalName]) resolve(globalName ? window[globalName] : true);
      else {
        delete lazyScriptPromises[key];
        reject(new Error(`${key} 라이브러리를 불러오지 못했습니다.`));
      }
    };
    script.onerror = () => {
      delete lazyScriptPromises[key];
      reject(new Error(`${key} 라이브러리를 불러오지 못했습니다.`));
    };
    document.head.appendChild(script);
  });

  return lazyScriptPromises[key];
}

function ensureXlsxLibrary() {
  return loadScriptWhenNeeded(
    'XLSX',
    'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
    'XLSX',
  );
}

function ensureHtml2CanvasLibrary() {
  return loadScriptWhenNeeded(
    'html2canvas',
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'html2canvas',
  );
}

function getDistrictOptionsHtml() {
  return ALL_DISTRICTS.map((name) => `<option value="${name}">${name}</option>`).join('');
}

function buildDistrictDropdown() {
  const html = getDistrictOptionsHtml();
  elDistrict.innerHTML = html;
  const last = localStorage.getItem(STORAGE_KEY_LASTDISTRICT) || '11구역';
  elDistrict.value = last;

  elPrayerDistrict.innerHTML = html;
  elPrayerImageDistrict.innerHTML = html;
  const prayerLast = localStorage.getItem(STORAGE_KEY_PRAYER_DISTRICT) || last;
  elPrayerDistrict.value = prayerLast;
  elPrayerImageDistrict.value = prayerLast;
}

function loadData() {
  const readJson = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn(`local data parse failed: ${key}`, error);
      return fallback;
    }
  };

  allMembersData = readJson(STORAGE_KEY_MEMBERS, {});
  allAttendanceRecords = readJson(STORAGE_KEY_RECORDS, {});
  allPrayerData = readJson(STORAGE_KEY_PRAYERS, {});
  const savedVolunteer = readJson(STORAGE_KEY_VOLUNTEER_STATE, null);
  if (savedVolunteer && Array.isArray(savedVolunteer.roster)) {
    volunteerState = {
      roster: savedVolunteer.roster.map(cloneVolunteerPerson),
      form: cloneVolunteerPerson(savedVolunteer.form || newVolunteerForm()),
    };
  }
}

function saveMembers() {
  localStorage.setItem(STORAGE_KEY_MEMBERS, JSON.stringify(allMembersData));
}

function rosterToday() {
  return localDateKey();
}

function newRosterId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function rosterCatNameToKey(catName) {
  const found = CAT_ORDER.find((k) => CATEGORIES[k].name === catName);
  return found ? CATEGORIES[found].key : 'eun';
}

function rosterKeyToCatName(key) {
  const found = CAT_ORDER.find((k) => CATEGORIES[k].key === key);
  return found ? CATEGORIES[found].name : '은장회';
}

function activeMemberDataFromRoster(members) {
  const data = { eun: [], bong: [], mom: [], youth: [] };
  (Array.isArray(members) ? members : []).forEach((m) => {
    if (!m || m.active === false || !m.name) return;
    const key = rosterCatNameToKey(m.cat);
    data[key].push(normalizeNameValue(m.name));
  });
  Object.keys(data).forEach((k) => (data[k] = uniqueNames(data[k])));
  return data;
}

function makeRosterFromLocalMembers(district) {
  const src = getMembersForDistrict(district);
  const members = [];
  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    uniqueNames(src[cat.key] || []).forEach((name) => {
      members.push({
        id: legacyMemberId(district, cat.name, name),
        name,
        cat: cat.name,
        active: true,
        joinedAt: rosterToday(),
        leftAt: '',
        reason: '',
      });
    });
  });
  return members;
}

async function syncRosterFromFirebase(district = elDistrict.value) {
  if (typeof window.getRosterFromFirebase !== 'function' || navigator.onLine === false) return false;
  try {
    const remote = await window.getRosterFromFirebase(district);
    const rawMembers = Array.isArray(remote?.members) ? remote.members : [];
    let members = normalizeRosterMembers(rawMembers, district);

    if (!remote?.exists) {
      members = makeRosterFromLocalMembers(district);
      if (members.length && typeof window.saveRosterFromFirebase === 'function') {
        const updatedAtMs = await window.saveRosterFromFirebase(district, members);
        allRosterData[district] = { exists: true, members, updatedAtMs };
      } else {
        allRosterData[district] = { exists: false, members: [], updatedAtMs: 0 };
      }
    } else {
      allRosterData[district] = {
        exists: true,
        members,
        updatedAtMs: Number(remote.updatedAtMs) || 0,
      };

      // 예전 명단에는 id가 없었습니다. 읽을 때 안정적인 id를 붙인 뒤
      // 한 번 서버에 기록해 이후 개명·구역 이동에도 같은 사람으로 추적합니다.
      const needsIdMigration = rawMembers.some(
        (member, index) => !member?.id || String(member.id) !== String(members[index]?.id || ''),
      );
      if (needsIdMigration && members.length) {
        try {
          const updatedAtMs = await window.saveRosterFromFirebase(district, members);
          allRosterData[district].updatedAtMs = updatedAtMs;
        } catch (migrationError) {
          console.warn('roster id migration save failed', migrationError);
        }
      }
    }

    if (members.length || remote?.exists) {
      allMembersData[district] = activeMemberDataFromRoster(members);
      saveMembers();
    }
    return true;
  } catch (err) {
    console.warn('roster sync failed', err);
    return false;
  }
}

async function saveActiveMemberDataToRoster(district, newData, reasonText = '구역장 명단에서 제외') {
  let remoteMembers = [];
  try {
    if (typeof window.getRosterFromFirebase === 'function' && navigator.onLine !== false) {
      const remote = await window.getRosterFromFirebase(district);
      remoteMembers = normalizeRosterMembers(remote?.members, district).map((m) => ({ ...m }));
    }
  } catch (err) {
    console.warn('roster fresh read failed', err);
  }

  if (!remoteMembers.length) {
    remoteMembers = (allRosterData[district]?.members || makeRosterFromLocalMembers(district)).map((m) => ({
      ...m,
    }));
  }

  const used = new Set();
  const result = normalizeRosterMembers(remoteMembers, district).map((m) => ({ ...m }));
  const desired = [];

  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    (newData[cat.key] || []).forEach((value) => {
      const source = value && typeof value === 'object' ? value : { name: value };
      const name = normalizeNameValue(source.name);
      if (name) desired.push({ id: String(source.id || ''), name, cat: cat.name });
    });
  });

  desired.forEach((item) => {
    let idx = item.id ? result.findIndex((m, i) => !used.has(i) && String(m.id || '') === item.id) : -1;
    if (idx < 0)
      idx = result.findIndex(
        (m, i) => !used.has(i) && m.active !== false && normalizeNameValue(m.name) === item.name,
      );
    if (idx < 0)
      idx = result.findIndex(
        (m, i) => !used.has(i) && m.active === false && normalizeNameValue(m.name) === item.name,
      );

    if (idx >= 0) {
      result[idx] = {
        ...result[idx],
        name: item.name,
        cat: item.cat,
        active: true,
        leftAt: '',
        reason: '',
        joinedAt: result[idx].joinedAt || rosterToday(),
      };
      used.add(idx);
    } else {
      result.push({
        id: newRosterId(),
        name: item.name,
        cat: item.cat,
        active: true,
        joinedAt: rosterToday(),
        leftAt: '',
        reason: '',
      });
      used.add(result.length - 1);
    }
  });

  result.forEach((m, i) => {
    if (m.active !== false && !used.has(i)) {
      m.active = false;
      m.leftAt = rosterToday();
      m.reason = m.reason || reasonText;
    }
  });

  if (typeof window.saveRosterFromFirebase === 'function' && navigator.onLine !== false) {
    const updatedAtMs = await window.saveRosterFromFirebase(district, result);
    allRosterData[district] = { exists: true, members: result, updatedAtMs };
  } else {
    allRosterData[district] = { exists: true, members: result, updatedAtMs: Date.now() };
  }

  allMembersData[district] = activeMemberDataFromRoster(result);
  saveMembers();

  return {
    members: result,
    inactiveCount: result.filter((m) => m.active === false).length,
  };
}

function saveRecords() {
  localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(allAttendanceRecords));
}

function readPendingAttendanceWrites() {
  return readPendingWrites(localStorage, STORAGE_KEY_PENDING_ATTENDANCE);
}

function withTimeout(promise, timeoutMs = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error('서버 응답 시간이 초과되었습니다.')), timeoutMs);
    }),
  ]);
}

function getPendingAttendanceWrite(district, date, type) {
  return getPendingWrite(localStorage, STORAGE_KEY_PENDING_ATTENDANCE, district, date, type);
}

function setPendingAttendanceWrite(entry) {
  setPendingWrite(localStorage, STORAGE_KEY_PENDING_ATTENDANCE, entry);
}

function clearPendingAttendanceWrite(district, date, type) {
  clearPendingWrite(localStorage, STORAGE_KEY_PENDING_ATTENDANCE, district, date, type);
}

function applyPendingAttendanceWrites(district) {
  applyPendingWrites(allAttendanceRecords, district, readPendingAttendanceWrites());
}

async function flushPendingAttendanceWrites() {
  const entries = Object.values(readPendingAttendanceWrites());
  if (!entries.length || navigator.onLine === false) return { ok: 0, fail: entries.length };

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      if (entry.op === 'delete') {
        await withTimeout(deleteAttendance(entry.district, entry.date, entry.type));
      } else {
        await withTimeout(submitAttendance(entry.payload));
      }
      clearPendingAttendanceWrite(entry.district, entry.date, entry.type);
    }),
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected')
      console.warn('pending attendance sync failed', entries[index], result.reason);
  });
  return {
    ok: results.filter((result) => result.status === 'fulfilled').length,
    fail: results.filter((result) => result.status === 'rejected').length,
  };
}

function getMembersForDistrict(district) {
  const d = district || elDistrict.value;
  if (!allMembersData[d]) allMembersData[d] = { eun: [], bong: [], mom: [], youth: [] };
  return allMembersData[d];
}

function getMembers() {
  return getMembersForDistrict(elDistrict.value);
}

function getFullRosterForDistrict(district = elDistrict.value) {
  const roster = allRosterData[district];
  if (roster && Array.isArray(roster.members)) return normalizeRosterMembers(roster.members, district);

  // 서버 명단을 아직 못 읽은 경우에는 기존 활동명단만 임시 표시
  const active = getMembersForDistrict(district);
  const fallback = [];
  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    uniqueNames(active[cat.key] || []).forEach((name) => {
      fallback.push({
        id: '',
        name,
        cat: cat.name,
        active: true,
        joinedAt: '',
        leftAt: '',
        reason: '',
      });
    });
  });
  return normalizeRosterMembers(fallback, district);
}

function getCategoryPeople(district, cat) {
  return getFullRosterForDistrict(district).filter(
    (person) => person && person.active !== false && (person.cat || '은장회') === cat.name,
  );
}

function personIsPresent(record, person, district, cat) {
  return recordHasPerson(record, person, district, cat.name);
}

async function quickSetRosterActive(personRef, makeActive) {
  const district = elDistrict.value;
  const target =
    personRef && typeof personRef === 'object' ? personRef : { id: personRef || '', name: '', cat: '' };

  const targetId = String(target.id || '');
  const targetName = normalizeNameValue(target.name || '');
  const targetCat = String(target.cat || '');

  let members = [];
  let remoteExists = false;

  try {
    if (typeof window.getRosterFromFirebase === 'function' && navigator.onLine !== false) {
      const fresh = await window.getRosterFromFirebase(district);
      remoteExists = !!fresh?.exists;
      members = Array.isArray(fresh?.members) ? fresh.members.map((m) => ({ ...m })) : [];
    }
  } catch (err) {
    console.warn('quick roster read failed', err);
  }

  if (!members.length) {
    members = makeRosterFromLocalMembers(district).map((m) => ({ ...m }));
  }

  members = normalizeRosterMembers(members, district);

  let person = null;

  if (targetId) {
    person = members.find((m) => String(m.id) === targetId) || null;
  }

  if (!person && targetName) {
    person =
      members.find(
        (m) =>
          normalizeNameValue(m.name) === targetName &&
          (!targetCat || String(m.cat || '') === targetCat) &&
          (makeActive ? m.active === false : m.active !== false),
      ) || null;
  }

  if (!person && targetName) {
    person =
      members.find(
        (m) => normalizeNameValue(m.name) === targetName && (!targetCat || String(m.cat || '') === targetCat),
      ) || null;
  }

  if (!person && targetName) {
    person = {
      id: newRosterId(),
      name: targetName,
      cat: targetCat || '은장회',
      active: true,
      joinedAt: rosterToday(),
      leftAt: '',
      reason: '',
    };
    members.push(person);
  }

  if (!person) {
    alert('명단 정보를 확인하지 못했습니다.\n명단설정에서 한 번 저장한 뒤 다시 시도해주세요.');
    return;
  }

  const actionText = makeActive ? '다시 활성화' : '비활성화';
  const guide = makeActive
    ? '현재 출석명단에 다시 표시됩니다.'
    : '현재 총원과 출석 대상에서는 빠지지만 과거 출석기록은 그대로 남습니다.';

  if (!confirm(`${person.name} 님을 ${actionText}할까요?\n${guide}`)) return;

  person.active = !!makeActive;
  if (makeActive) {
    person.leftAt = '';
    person.reason = '';
    person.joinedAt = person.joinedAt || rosterToday();
  } else {
    person.leftAt = rosterToday();
    person.reason = person.reason || '출석화면에서 비활성화';

    const nextRecord = removePersonFromRecord(workingRecord, person, district, person.cat);
    if (nextRecord.length !== workingRecord.length) {
      workingRecord = nextRecord;
      isDirty = true;
      updateSaveIndicator(false);
    }
  }

  try {
    if (typeof window.saveRosterFromFirebase === 'function' && navigator.onLine !== false) {
      const updatedAtMs = await window.saveRosterFromFirebase(district, members);
      allRosterData[district] = { exists: true, members, updatedAtMs };
    } else {
      allRosterData[district] = { exists: remoteExists, members, updatedAtMs: Date.now() };
    }

    allMembersData[district] = activeMemberDataFromRoster(members);
    saveMembers();
    renderAttendanceGrid();

    if (makeActive) {
      alert(`${person.name} 님을 다시 활성화했습니다.`);
    } else {
      alert(`${person.name} 님을 비활성화했습니다.\n과거 출석기록은 삭제되지 않습니다.`);
    }
  } catch (err) {
    console.error('quick roster save failed', err);
    alert('명단 변경을 저장하지 못했습니다.\n인터넷 연결 또는 서버 권한을 확인해주세요.');
  }
}

function getRecords() {
  const d = elDistrict.value;
  if (!allAttendanceRecords[d]) allAttendanceRecords[d] = {};
  return allAttendanceRecords[d];
}

function isValidRecordDateKey(dateKey) {
  return isValidDateKey(dateKey);
}

function getValidRecordDates(records, reverse = false) {
  const dates = Object.keys(records || {})
    .filter(isValidRecordDateKey)
    .sort();
  return reverse ? dates.reverse() : dates;
}

function hideSubmitBtn() {
  /* 새 디자인에서는 제출 버튼이 상시 노출됩니다. */
}

function loadWorkingRecord() {
  const records = getRecords();
  const date = elDate.value;
  const type = elType.value;
  const saved = (records[date] && records[date][type]) || null;
  workingRecord = saved ? [...saved] : [];
  isDirty = false;
  updateSaveIndicator(saved !== null);
  updateRecordStatusBanner(saved !== null);
  updateAllVisuals();
}

function updateSaveIndicator(isSaved) {
  if (isDirty) {
    elSaveIndicator.textContent = '● 저장되지 않은 변경사항이 있습니다';
    elSaveIndicator.className = 'save-indicator unsaved';
    elBtnSaveRecord.disabled = false;
  } else if (getPendingAttendanceWrite(elDistrict.value, elDate.value, elType.value)) {
    elSaveIndicator.textContent = '● 기기에 저장됨 · 서버 전송 대기';
    elSaveIndicator.className = 'save-indicator pending';
    elBtnSaveRecord.disabled = true;
  } else if (isSaved) {
    elSaveIndicator.textContent = '✓ 저장되었습니다';
    elSaveIndicator.className = 'save-indicator saved';
    elBtnSaveRecord.disabled = true;
  } else {
    elSaveIndicator.textContent = '출석 체크 후 [저장하기]를 눌러주세요';
    elSaveIndicator.className = 'save-indicator';
    elBtnSaveRecord.disabled = false;
  }
}

function updateRecordStatusBanner(isSaved) {
  if (isSaved) {
    elRecordStatusWrap.innerHTML = `<div class="record-status">이 날짜에 저장된 기록을 불러왔습니다. 수정 후 다시 저장하면 덮어쓰기 됩니다.</div>`;
  } else {
    elRecordStatusWrap.innerHTML = '';
  }
}

function renderAttendanceGrid() {
  const district = elDistrict.value;
  const members = getMembers();
  const fullRoster = getFullRosterForDistrict(district);

  const hasAnyActive = CAT_ORDER.some((k) => (members[CATEGORIES[k].key] || []).length > 0);
  const hasAnyRoster = fullRoster.length > 0;

  if (!hasAnyActive && !hasAnyRoster) {
    elAttendance.innerHTML = `<div class="card"><div class="empty-msg">${elDistrict.value} 명단이 비어있습니다.<br>하단 명단설정을 눌러 입력해주세요.</div></div>`;
    updateAllVisuals();
    return;
  }

  elAttendance.innerHTML = '';

  const inactiveTotal = fullRoster.filter((m) => m && m.active === false).length;
  if (inactiveTotal > 0) {
    const note = document.createElement('div');
    note.className = 'member-inactive-note';
    note.innerHTML = `회색 이름은 <b>비활성 인원 ${inactiveTotal}명</b>입니다. 현재 총원·출석 대상에서는 제외되며 과거 기록은 유지됩니다.`;
    elAttendance.appendChild(note);
  }

  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    const activePeople = getCategoryPeople(district, cat);
    const categoryRoster = fullRoster.filter((m) => m && (m.cat || '은장회') === cat.name);
    const inactivePeople = categoryRoster.filter((m) => m.active === false);

    // 서버 roster가 없을 때 기존 명단만 표시
    let displayPeople = categoryRoster.length
      ? categoryRoster
      : (members[cat.key] || []).map((name) => ({
          id: legacyMemberId(district, cat.name, name),
          name,
          cat: cat.name,
          active: true,
        }));

    if (displayPeople.length === 0) return;

    const attendedCount = activePeople.filter((person) =>
      personIsPresent(workingRecord, person, district, cat),
    ).length;

    const section = document.createElement('section');
    section.className = 'member-section';
    section.id = `section-${cat.key}`;

    const header = document.createElement('div');
    header.className = `member-section-header ${cat.btnClass}`;
    header.innerHTML = `
                <div class="mini-icon ${cat.cardClass}"><div class="cat-icon" style="width:34px;height:34px;margin:0;"><i data-lucide="${cat.icon}"></i></div></div>
                <div class="cat-title-text" style="color:${getCatColor(cat.key)}">${cat.name}</div>
                <div class="cat-sub">활동 ${activePeople.length}명 · 출석 ${attendedCount}명${inactivePeople.length ? ` · 비활성 ${inactivePeople.length}명` : ''}</div>
                <div class="fold-mark"><i data-lucide="chevron-up"></i></div>
            `;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'member-grid';

    header.addEventListener('click', () => {
      const isHidden = grid.style.display === 'none';
      grid.style.display = isHidden ? 'grid' : 'none';

      const icon = header.querySelector('.fold-mark i');
      if (icon) icon.setAttribute('data-lucide', isHidden ? 'chevron-up' : 'chevron-down');

      refreshIcons();
    });

    // 활동 인원 먼저, 비활성 인원은 뒤쪽에 배치
    displayPeople = [...displayPeople].sort((a, b) => {
      const activeDiff = (a.active === false ? 1 : 0) - (b.active === false ? 1 : 0);
      if (activeDiff !== 0) return activeDiff;
      return String(a.name || '').localeCompare(String(b.name || ''), 'ko');
    });

    displayPeople.forEach((person) => {
      const name = normalizeNameValue(person.name);
      if (!name) return;

      const isInactive = person.active === false;
      const cell = document.createElement('div');
      cell.className = `member-cell${isInactive ? ' inactive' : ''}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `member-btn ${cat.btnClass}`;

      if (isInactive) {
        const hadAttendance = personIsPresent(workingRecord, person, district, cat);
        btn.classList.add('inactive');
        if (hadAttendance) btn.classList.add('had-attendance');
        btn.disabled = true;
        btn.innerHTML = `<span>${escapeHtml(name)}</span><span class="inactive-label">${hadAttendance ? '비활성 · 기존 출석기록 있음' : '비활성'}</span>`;
      } else {
        if (personIsPresent(workingRecord, person, district, cat)) btn.classList.add('active');
        btn.textContent = name;
        btn.addEventListener('click', () => toggleAttendance(person, cat, btn));
      }

      cell.appendChild(btn);

      const manageBtn = document.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'member-quick-btn';
      manageBtn.textContent = isInactive ? '↻' : '⋯';
      manageBtn.setAttribute('aria-label', isInactive ? `${name} 활성화` : `${name} 명단 관리`);
      manageBtn.title = isInactive ? '다시 활성화' : '비활성화';
      manageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        quickSetRosterActive({ id: person.id, name, cat: cat.name }, isInactive);
      });

      cell.appendChild(manageBtn);
      grid.appendChild(cell);
    });

    section.appendChild(grid);
    elAttendance.appendChild(section);
  });

  updateAllVisuals();
  refreshIcons();
}

function getCatColor(key) {
  if (key === 'eun') return 'var(--primary)';
  if (key === 'bong') return 'var(--green)';
  if (key === 'mom') return 'var(--pink)';
  if (key === 'youth') return 'var(--purple)';
  return 'var(--navy)';
}

function toggleAttendance(person, cat, btnEl) {
  workingRecord = togglePersonInRecord(workingRecord, person, elDistrict.value, cat.name);
  btnEl.classList.toggle('active', personIsPresent(workingRecord, person, elDistrict.value, cat));
  isDirty = true;
  updateSaveIndicator(false);
  updateAllVisuals();
  updateCategoryTitles();
}

function updateAllVisuals() {
  updateCategoryTitles();
}

function updateCategoryTitles() {
  const district = elDistrict.value;
  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    const section = document.getElementById(`section-${cat.key}`);
    if (!section) return;
    const people = getCategoryPeople(district, cat);
    const attended = people.filter((person) => personIsPresent(workingRecord, person, district, cat)).length;
    const sub = section.querySelector('.cat-sub');
    if (sub) sub.textContent = `전체 ${people.length}명 · 출석 ${attended}명`;
  });
}

function getSelectedMonthKey() {
  const value = elDate.value || localDateKey();
  return value.slice(0, 7);
}

function parseMonthlyNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getMonthlyOfficialTotal(data = currentMonthlyActivity) {
  if (!data) return null;
  const admin = parseMonthlyNumber(data.관리자확정총원);
  if (admin !== null) return admin;
  return parseMonthlyNumber(data.구역장입력총원);
}

async function loadMonthlyActivity() {
  const monthKey = getSelectedMonthKey();
  document.getElementById('monthly-activity-month').textContent = `${Number(monthKey.slice(5))}월`;

  try {
    if (typeof window.getMonthlyActivityFromFirebase === 'function') {
      currentMonthlyActivity = await window.getMonthlyActivityFromFirebase(elDistrict.value, monthKey);
    } else {
      currentMonthlyActivity = null;
    }
  } catch (err) {
    console.warn('monthly activity load failed', err);
    currentMonthlyActivity = null;
  }

  renderMonthlyActivitySummary();
}

function renderMonthlyActivitySummary() {
  const x = currentMonthlyActivity || {};
  const leader = parseMonthlyNumber(x.구역장입력총원);
  const admin = parseMonthlyNumber(x.관리자확정총원);
  const evangelism = Array.isArray(x.전도) ? x.전도 : [];
  const visits = Array.isArray(x.심방) ? x.심방 : [];

  const leaderEl = document.getElementById('monthly-leader-total');
  const adminEl = document.getElementById('monthly-admin-total');
  leaderEl.textContent = leader === null ? '—' : `${leader}명`;
  adminEl.textContent = admin === null ? '미확정' : `${admin}명`;
  adminEl.className = x.상태 === '확인대기' ? 'wait' : admin !== null ? 'ok' : '';

  document.getElementById('monthly-evangelism-count').textContent = `${evangelism.length}명`;
  document.getElementById('monthly-visit-count').textContent = `${visits.length}명`;

  const note = document.getElementById('monthly-activity-note');
  if (!currentMonthlyActivity) {
    note.textContent = '아직 월간 기록이 없습니다. 총원·전도·심방을 입력해주세요.';
  } else if (x.상태 === '확인대기') {
    note.textContent =
      admin === null
        ? '총원은 관리자 확인 대기 중입니다.'
        : `총원 변경 확인 대기 중입니다. 현재 공식값은 관리자 확정 ${admin}명입니다.`;
  } else if (admin !== null) {
    note.textContent = `관리자가 ${admin}명으로 확정했습니다. 이 값이 통계 기준입니다.`;
  } else {
    note.textContent = '총원은 관리자 확인 전입니다.';
  }
}

function addMonthlyEvangelismRow(item = {}) {
  const wrap = document.getElementById('monthly-evangelism-rows');
  const row = document.createElement('div');
  row.className = 'monthly-pair-row';
  row.innerHTML = `
            <input type="text" class="monthly-evangelism-name" placeholder="이름" value="${escapeAttr(item.이름 || '')}">
            <input type="text" class="monthly-evangelism-guide" placeholder="인도자" value="${escapeAttr(item.인도자 || '')}">
            <button class="monthly-row-delete" type="button">×</button>`;
  row.querySelector('.monthly-row-delete').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

function addMonthlyVisitRow(item = {}) {
  const wrap = document.getElementById('monthly-visit-rows');
  const row = document.createElement('div');
  row.className = 'monthly-pair-row';
  row.innerHTML = `
            <input type="text" class="monthly-visit-name" placeholder="이름" value="${escapeAttr(item.이름 || '')}">
            <input type="date" class="monthly-visit-date" value="${escapeAttr(item.날짜 || elDate.value || '')}">
            <button class="monthly-row-delete" type="button">×</button>`;
  row.querySelector('.monthly-row-delete').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

function openMonthlyActivityModal() {
  const monthKey = getSelectedMonthKey();
  const x = currentMonthlyActivity || {};
  const leader = parseMonthlyNumber(x.구역장입력총원);
  const admin = parseMonthlyNumber(x.관리자확정총원);

  document.getElementById('monthly-activity-modal-title').textContent =
    `${elDistrict.value} · ${monthKey} 월간 기록`;
  document.getElementById('monthly-total-input').value = leader === null ? '' : leader;

  const info = document.getElementById('monthly-confirm-info');
  if (admin === null) {
    info.innerHTML = '관리자 확정 전입니다.<br>총원을 저장하면 관리자에게 확인 대기로 표시됩니다.';
  } else if (x.상태 === '확인대기') {
    info.innerHTML = `현재 관리자 확정 총원 <b>${admin}명</b><br>새 구역장 입력값은 관리자 재확인 대기 중입니다.`;
  } else {
    info.innerHTML = `관리자 확정 총원 <b>${admin}명</b><br>현재 통계는 이 값을 기준으로 계산합니다.`;
  }

  const evWrap = document.getElementById('monthly-evangelism-rows');
  evWrap.innerHTML = '';
  const evangelism = Array.isArray(x.전도) ? x.전도 : [];
  if (evangelism.length) evangelism.forEach(addMonthlyEvangelismRow);
  else addMonthlyEvangelismRow();

  const visitWrap = document.getElementById('monthly-visit-rows');
  visitWrap.innerHTML = '';
  const visits = Array.isArray(x.심방) ? x.심방 : [];
  if (visits.length) visits.forEach(addMonthlyVisitRow);
  else addMonthlyVisitRow();

  document.getElementById('monthly-activity-modal').classList.add('show');
}

function collectMonthlyEvangelism() {
  return Array.from(document.querySelectorAll('#monthly-evangelism-rows .monthly-pair-row'))
    .map((row) => ({
      이름: normalizeNameValue(row.querySelector('.monthly-evangelism-name').value),
      인도자: normalizeNameValue(row.querySelector('.monthly-evangelism-guide').value),
    }))
    .filter((item) => item.이름);
}

function collectMonthlyVisits() {
  return Array.from(document.querySelectorAll('#monthly-visit-rows .monthly-pair-row'))
    .map((row) => ({
      이름: normalizeNameValue(row.querySelector('.monthly-visit-name').value),
      날짜: row.querySelector('.monthly-visit-date').value || '',
    }))
    .filter((item) => item.이름);
}

async function saveMonthlyActivity() {
  const totalInput = document.getElementById('monthly-total-input');
  const total = Number(totalInput.value);

  if (!Number.isFinite(total) || total < 0) {
    alert('총원을 입력해주세요.');
    totalInput.focus();
    return;
  }

  const monthKey = getSelectedMonthKey();
  let old = currentMonthlyActivity || null;

  if (!old && typeof window.getMonthlyActivityFromFirebase === 'function') {
    try {
      old = await window.getMonthlyActivityFromFirebase(elDistrict.value, monthKey);
    } catch (err) {
      console.warn('monthly activity pre-load failed', err);
    }
  }

  old = old || {};
  const oldLeader = parseMonthlyNumber(old.구역장입력총원);
  const admin = parseMonthlyNumber(old.관리자확정총원);
  const totalChanged = oldLeader === null || oldLeader !== total;
  const history = Array.isArray(old.총원이력) ? [...old.총원이력] : [];

  if (totalChanged) {
    history.push({
      구분: '구역장입력',
      값: total,
      일시: new Date().toISOString(),
    });
  }

  let status = old.상태 || '확인대기';
  if (totalChanged) {
    status = admin !== null && admin === total ? '확정' : '확인대기';
  }

  const data = {
    구역장입력총원: total,
    전도: collectMonthlyEvangelism(),
    심방: collectMonthlyVisits(),
    상태: status,
    총원이력: history,
    구역장입력일시: totalChanged ? new Date().toISOString() : old.구역장입력일시 || '',
    구역장마지막수정일시: new Date().toISOString(),
  };

  try {
    if (typeof window.saveMonthlyActivityToFirebase !== 'function') {
      throw new Error('서버 저장 기능을 불러오지 못했습니다.');
    }

    await window.saveMonthlyActivityToFirebase(elDistrict.value, monthKey, data);
    document.getElementById('monthly-activity-modal').classList.remove('show');
    await loadMonthlyActivity();

    if (totalChanged && status === '확인대기') {
      alert('월간 기록을 저장했습니다.\n총원 변경 내용은 관리자 확인 대기로 등록되었습니다.');
    } else {
      alert('월간 기록을 저장했습니다.');
    }
  } catch (err) {
    alert('월간 기록 저장에 실패했습니다: ' + err.message);
  }
}

function buildFirebaseSubmissionPayload(options = {}) {
  const district = options.district || elDistrict.value;
  const date = options.date || elDate.value;
  const targetType = options.type || elType.value;
  const targetRecord = Array.isArray(options.record) ? options.record : workingRecord;
  const attendanceData = {};

  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    const people = getCategoryPeople(district, cat);
    const presentPeople = people.filter((person) => personIsPresent(targetRecord, person, district, cat));

    attendanceData[cat.name] = {
      // 이름은 기존 관리자/내보내기와의 호환용이며, 식별은 같은 순서의 ID를 사용합니다.
      전체: people.map((person) => person.name),
      전체ID: people.map((person) => ensureMemberId(person, district, cat.name)),
      출석: presentPeople.map((person) => person.name),
      출석ID: presentPeople.map((person) => ensureMemberId(person, district, cat.name)),
      인원: presentPeople.length,
    };
  });

  return {
    schemaVersion: 2,
    구역: district,
    날짜: date,
    모임: targetType,
    출석데이터: attendanceData,
  };
}

function formatNoticeDate(dateKey) {
  return formatKoreanDate(dateKey);
}

function getExpectedMeetingTypeByDate(dateKey) {
  return expectedMeetingTypeForDate(dateKey);
}

function confirmMeetingDateMismatch(dateKey, selectedType) {
  if (selectedType !== '주일말씀' && selectedType !== '수요말씀') return true;
  const expected = getExpectedMeetingTypeByDate(dateKey);
  if (!expected || expected === selectedType) return true;

  return confirm(
    `${formatNoticeDate(dateKey)}은 ${expected}입니다.\n` +
      `현재 ${selectedType}으로 선택되어 있습니다.\n\n` +
      `그래도 저장하시겠습니까?`,
  );
}

async function syncAllLocalRecordsToFirebase() {
  if (typeof window.submitAttendanceToFirebase !== 'function') return { ok: 0, fail: 0 };

  let ok = 0;
  let fail = 0;

  const districtEntries = Object.entries(allAttendanceRecords || {});
  for (const [district, districtRecords] of districtEntries) {
    const validDates = getValidRecordDates(districtRecords || {});

    for (const date of validDates) {
      const dayRecords = districtRecords[date] || {};
      for (const [type, record] of Object.entries(dayRecords)) {
        if (!Array.isArray(record)) continue;

        try {
          await window.submitAttendanceToFirebase(
            buildFirebaseSubmissionPayload({
              district,
              date,
              type,
              record,
            }),
          );
          ok++;
        } catch (err) {
          fail++;
          console.warn('remote full sync item failed', district, date, type, err);
        }
      }
    }
  }

  return { ok, fail };
}

async function syncCurrentDistrictRecordsToFirebase(district = elDistrict.value) {
  if (typeof window.submitAttendanceToFirebase !== 'function') return { ok: 0, fail: 0 };

  const districtRecords = allAttendanceRecords[district] || {};
  const validDates = getValidRecordDates(districtRecords || {});
  let ok = 0;
  let fail = 0;

  for (const date of validDates) {
    const dayRecords = districtRecords[date] || {};
    for (const [type, record] of Object.entries(dayRecords)) {
      if (!Array.isArray(record)) continue;

      try {
        await window.submitAttendanceToFirebase(
          buildFirebaseSubmissionPayload({
            district,
            date,
            type,
            record,
          }),
        );
        ok++;
      } catch (err) {
        fail++;
        console.warn('current district full sync failed', district, date, type, err);
      }
    }
  }

  return { ok, fail };
}

async function syncMovedRecordToFirebase(date, oldType, newType, namesToMove) {
  const district = elDistrict.value;
  const saveResult = await syncCurrentRecordToFirebase(date, newType, namesToMove, true, district);
  const deleteResult =
    oldType === newType
      ? { serverSaved: true, queued: false }
      : await syncCurrentRecordToFirebase(date, oldType, [], false, district);
  return {
    serverSaved: saveResult.serverSaved && deleteResult.serverSaved,
    queued: saveResult.queued || deleteResult.queued,
  };
}

async function saveCurrentRecord() {
  const district = elDistrict.value;
  const date = elDate.value;
  const type = elType.value;
  const currentNames = [...workingRecord];

  if (!confirmMeetingDateMismatch(date, type)) return;

  if (currentNames.length === 0) {
    if (!confirm('출석자가 0명입니다. 저장하시겠습니까?\n기존 기록이 있다면 0명으로 덮어쓰기 됩니다.'))
      return;
  }

  await syncDistrictFromFirebase(district);
  const records = getRecords();

  if (!records[date]) records[date] = {};
  records[date][type] = currentNames;

  if (records[date][type].length === 0) {
    delete records[date][type];
    if (Object.keys(records[date]).length === 0) delete records[date];
  }

  saveRecords();
  isDirty = false;

  const stillExists = records[date] && records[date][type];
  workingRecord = stillExists ? [...records[date][type]] : [];
  updateSaveIndicator(!!stillExists);
  updateRecordStatusBanner(!!stillExists);
  updateAllVisuals();

  // 현재 저장한 회차만 서버에 반영한다.
  // 과거 모든 회차를 현재 명단으로 다시 올리지 않아,
  // 명단 비활성화가 과거 출석기록의 '전체 명단'을 덮어쓰지 않는다.
  const syncResult = await syncCurrentRecordToFirebase(date, type, currentNames, !!stillExists);

  if (syncResult.serverSaved) {
    markServerSyncedDistrict(district);
    updateSaveIndicator(!!stillExists);
    alert('저장되었습니다.');
  } else {
    updateSaveIndicator(!!stillExists);
    alert('기기에는 저장했습니다.\n서버 저장은 대기 중이며 인터넷 연결이 복구되면 자동으로 다시 전송합니다.');
  }
}
async function moveCurrentRecordToMeeting(oldType, newType) {
  const date = elDate.value;
  const records = getRecords();
  const namesToMove = [...workingRecord];

  if (!records[date]) records[date] = {};

  if (records[date][newType] && records[date][newType].length > 0) {
    const overwrite = confirm(`${newType}에 이미 저장된 기록이 있습니다.\n현재 체크 명단으로 덮어쓸까요?`);
    if (!overwrite) {
      elType.value = oldType;
      previousMeetingType = oldType;
      return false;
    }
  }

  records[date][newType] = namesToMove;

  if (records[date][oldType]) {
    delete records[date][oldType];
  }

  if (Object.keys(records[date]).length === 0) {
    delete records[date];
  }

  saveRecords();
  isDirty = false;
  previousMeetingType = newType;
  elType.value = newType;

  const syncResult = await syncMovedRecordToFirebase(date, oldType, newType, namesToMove);

  loadWorkingRecord();
  renderAttendanceGrid();

  alert(
    syncResult.serverSaved
      ? `${oldType} 기록을 ${newType}(으)로 옮겼습니다.`
      : `${oldType} 기록을 기기에서 ${newType}(으)로 옮겼습니다.\n서버 반영은 인터넷 연결 복구 후 자동으로 다시 시도합니다.`,
  );
  return true;
}

function handleMeetingTypeChange() {
  const newType = elType.value;
  const oldType = previousMeetingType || newType;

  if (newType === oldType) return;

  if (workingRecord.length > 0) {
    const shouldMove = confirm(
      `현재 체크한 명단을 ${newType}(으)로 옮길까요?\n\n` +
        `확인: ${oldType} 기록을 ${newType}(으)로 이동합니다.\n` +
        `취소: 이동하지 않고 ${newType} 화면만 엽니다.`,
    );

    if (shouldMove) {
      void moveCurrentRecordToMeeting(oldType, newType);
      return;
    }
  }

  if (isDirty && !confirm('저장하지 않은 변경사항이 있습니다. 변경사항을 버리고 이동하시겠습니까?')) {
    elType.value = oldType;
    return;
  }

  previousMeetingType = newType;
  loadWorkingRecord();
  renderAttendanceGrid();
}

function confirmIfDirty() {
  if (isDirty) return confirm('저장하지 않은 변경사항이 있습니다. 변경사항을 버리고 이동하시겠습니까?');
  return true;
}

function createNameRow(catKey, name, memberId = '') {
  const row = document.createElement('div');
  row.className = 'setup-name-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'setup-name-input';
  input.placeholder = '이름 입력';
  input.value = name || '';
  input.dataset.memberId = memberId;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const allInputs = Array.from(document.querySelectorAll(`#setup-list-${catKey} .setup-name-input`));
      const idx = allInputs.indexOf(input);
      if (idx < allInputs.length - 1) allInputs[idx + 1].focus();
      else document.getElementById(`btn-add-${catKey}`).click();
    }
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'btn-remove-name';
  delBtn.textContent = '×';
  delBtn.type = 'button';

  delBtn.addEventListener('click', () => {
    const list = document.getElementById(`setup-list-${catKey}`);
    if (list.querySelectorAll('.setup-name-row').length === 1) {
      input.value = '';
      input.focus();
    } else {
      row.remove();
    }
  });

  row.appendChild(input);
  row.appendChild(delBtn);
  return row;
}

async function openSetup() {
  await syncRosterFromFirebase(elDistrict.value);
  elSetupDistrictLabel.textContent = `(${elDistrict.value})`;

  const container = document.getElementById('setup-cat-list');
  container.innerHTML = '';

  CAT_ORDER.forEach((k, idx) => {
    const cat = CATEGORIES[k];
    const people = getCategoryPeople(elDistrict.value, cat);

    const block = document.createElement('div');
    block.className = 'setup-cat-block';

    const label = document.createElement('div');
    label.className = `setup-cat-label ${cat.btnClass}`;
    label.textContent = cat.name;
    block.appendChild(label);

    const list = document.createElement('div');
    list.className = 'setup-name-list';
    list.id = `setup-list-${cat.key}`;

    const seedPeople = people.length > 0 ? people : [{ id: '', name: '' }];
    seedPeople.forEach((person) => list.appendChild(createNameRow(cat.key, person.name, person.id)));

    block.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-name';
    addBtn.id = `btn-add-${cat.key}`;
    addBtn.type = 'button';
    addBtn.textContent = '+ 이름 추가';
    addBtn.addEventListener('click', () => {
      const newRow = createNameRow(cat.key, '');
      list.appendChild(newRow);
      newRow.querySelector('input').focus();
    });

    block.appendChild(addBtn);

    if (idx < CAT_ORDER.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'setup-cat-divider';
      block.appendChild(divider);
    }

    container.appendChild(block);
  });

  document.getElementById('setup-modal').classList.add('show');
}

function normalizeNameValue(value) {
  return normalizeName(value);
}

function uniqueNames(names) {
  const seen = new Set();
  const result = [];

  names.forEach((name) => {
    const clean = normalizeNameValue(name);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    result.push(clean);
  });

  return result;
}

function makeEmptyMemberData() {
  return { eun: [], bong: [], mom: [], youth: [] };
}

function downloadBlobFile(blob, fileName, title = '파일 저장') {
  const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title }).catch((err) => {
      if (err.name !== 'AbortError') fallbackBlobDownload(blob, fileName);
    });
    return;
  }

  fallbackBlobDownload(blob, fileName);
}

function fallbackBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = fileName;
  a.style.display = 'none';

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadMemberTemplate() {
  try {
    await ensureXlsxLibrary();
  } catch (err) {
    console.warn('XLSX lazy load failed', err);
  }
  const rows = [
    ['은장회', '봉사회', '어머니회', '청년회'],
    ['홍길동', '김봉사', '이어머니', '박청년'],
    ['', '', '', ''],
    ['', '', '', ''],
  ];

  if (window.XLSX) {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(workbook, sheet, '구역원명단');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    downloadBlobFile(blob, `${elDistrict.value}_구역원명단_업로드서식.xlsx`, '구역원명단 엑셀 서식');
    return;
  }

  const csv =
    '\ufeff' +
    rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlobFile(blob, `${elDistrict.value}_구역원명단_업로드서식.csv`, '구역원명단 CSV 서식');
}

function triggerFilePicker(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = '';
  input.click();
}

function parseCSVText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if ((ch === ',' || ch === '\t') && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function findHeaderIndex(headers, patterns) {
  return headers.findIndex((h) => patterns.some((p) => h.includes(p)));
}

function parseMemberRows(rows) {
  const cleanedRows = rows
    .map((row) => row.map((cell) => normalizeNameValue(cell)))
    .filter((row) => row.some((cell) => cell.length > 0));

  if (cleanedRows.length === 0) return makeEmptyMemberData();

  const headers = cleanedRows[0].map((h) => h.replace(/\s/g, ''));
  const dataRows = cleanedRows.slice(1);

  const colMap = {
    eun: findHeaderIndex(headers, ['은장회', '은장']),
    bong: findHeaderIndex(headers, ['봉사회', '봉사']),
    mom: findHeaderIndex(headers, ['어머니회', '어머니', '모친']),
    youth: findHeaderIndex(headers, ['청년회', '청년']),
  };

  const hasWideFormat = Object.values(colMap).some((idx) => idx >= 0);

  const result = makeEmptyMemberData();

  if (hasWideFormat) {
    dataRows.forEach((row) => {
      Object.entries(colMap).forEach(([key, idx]) => {
        if (idx < 0) return;
        const name = normalizeNameValue(row[idx]);
        if (name) result[key].push(name);
      });
    });

    result.eun = uniqueNames(result.eun);
    result.bong = uniqueNames(result.bong);
    result.mom = uniqueNames(result.mom);
    result.youth = uniqueNames(result.youth);

    return result;
  }

  const categoryIdx = findHeaderIndex(headers, ['구분', '범주', '분류', '회']);
  const nameIdx = findHeaderIndex(headers, ['이름', '성명', '구역원']);

  if (categoryIdx >= 0 && nameIdx >= 0) {
    dataRows.forEach((row) => {
      const category = normalizeNameValue(row[categoryIdx]);
      const name = normalizeNameValue(row[nameIdx]);
      if (!name) return;

      if (category.includes('은장')) result.eun.push(name);
      else if (category.includes('봉사')) result.bong.push(name);
      else if (category.includes('어머니')) result.mom.push(name);
      else if (category.includes('청년')) result.youth.push(name);
    });

    result.eun = uniqueNames(result.eun);
    result.bong = uniqueNames(result.bong);
    result.mom = uniqueNames(result.mom);
    result.youth = uniqueNames(result.youth);

    return result;
  }

  return makeEmptyMemberData();
}

function countUploadedMembers(data) {
  return CAT_ORDER.reduce((sum, k) => sum + (data[CATEGORIES[k].key] || []).length, 0);
}

async function applyUploadedMembers(newData) {
  const total = countUploadedMembers(newData);

  if (total === 0) {
    alert(
      '업로드할 이름을 찾지 못했습니다.\n엑셀 서식의 첫 줄 제목이 은장회, 봉사회, 어머니회, 청년회인지 확인해주세요.\n이름은 제목 아래 칸에 입력해야 합니다.',
    );
    return;
  }

  const current = getMembers();
  const currentTotal = CAT_ORDER.reduce((sum, k) => sum + (current[CATEGORIES[k].key] || []).length, 0);

  if (currentTotal > 0) {
    const ok = confirm(
      `${elDistrict.value} 기존 명단 ${currentTotal}명을\n업로드 명단 ${total}명으로 교체할까요?`,
    );
    if (!ok) return;
  }

  await saveActiveMemberDataToRoster(
    elDistrict.value,
    {
      eun: newData.eun || [],
      bong: newData.bong || [],
      mom: newData.mom || [],
      youth: newData.youth || [],
    },
    '구역장 명단 업로드에서 제외',
  );

  loadWorkingRecord();
  renderAttendanceGrid();

  if (document.getElementById('setup-modal').classList.contains('show')) {
    await openSetup();
  }

  alert(
    `명단 업로드 완료!\n\n` +
      `은장회 ${newData.eun.length}명\n` +
      `봉사회 ${newData.bong.length}명\n` +
      `어머니회 ${newData.mom.length}명\n` +
      `청년회 ${newData.youth.length}명`,
  );
}

function readFileAsArrayBuffer(file) {
  if (file && typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function decodeTextWithFallback(buffer) {
  const bytes = new Uint8Array(buffer);
  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

  if (hasUtf8Bom) {
    return new TextDecoder('utf-8').decode(buffer);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (e) {
    try {
      return new TextDecoder('euc-kr').decode(buffer);
    } catch (fallbackError) {
      return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    }
  }
}

function readFileAsText(file) {
  return readFileAsArrayBuffer(file).then((buffer) => decodeTextWithFallback(buffer));
}

async function handleMemberFileUpload(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';

  if (!file) return;

  const name = file.name.toLowerCase();

  try {
    let rows = [];

    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      const text = await readFileAsText(file);
      rows = parseCSVText(text.replace(/^\ufeff/, ''));
    } else {
      try {
        await ensureXlsxLibrary();
      } catch (loadErr) {
        alert('엑셀 읽기 기능을 불러오지 못했습니다.\nCSV 파일로 다시 시도해주세요.');
        return;
      }

      if (!window.XLSX) {
        alert('엑셀 읽기 기능을 불러오지 못했습니다.\nCSV 파일로 다시 시도해주세요.');
        return;
      }

      const buffer = await readFileAsArrayBuffer(file);
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    }

    const newData = parseMemberRows(rows);
    await applyUploadedMembers(newData);
  } catch (err) {
    alert('명단 업로드에 실패했습니다: ' + err.message);
  }
}

async function saveSetup() {
  const newData = { eun: [], bong: [], mom: [], youth: [] };

  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    const inputs = document.querySelectorAll(`#setup-list-${cat.key} .setup-name-input`);
    newData[cat.key] = Array.from(inputs)
      .map((input) => ({
        id: String(input.dataset.memberId || ''),
        name: normalizeNameValue(input.value),
      }))
      .filter((person) => person.name);
  });

  const beforeTotal = CAT_ORDER.reduce(
    (sum, k) => sum + getCategoryPeople(elDistrict.value, CATEGORIES[k]).length,
    0,
  );
  const afterTotal = CAT_ORDER.reduce((sum, k) => sum + (newData[CATEGORIES[k].key] || []).length, 0);

  try {
    await saveActiveMemberDataToRoster(elDistrict.value, newData, '구역장 명단에서 제외');
    document.getElementById('setup-modal').classList.remove('show');
    loadWorkingRecord();
    renderAttendanceGrid();

    const removed = Math.max(beforeTotal - afterTotal, 0);
    if (removed > 0) {
      alert(
        `명단을 저장했습니다.\n빠진 ${removed}명은 삭제하지 않고 비활성화했습니다.\n과거 출석 기록은 그대로 유지됩니다.`,
      );
    } else {
      alert('명단을 저장했습니다.');
    }
  } catch (err) {
    alert('명단 저장에 실패했습니다: ' + err.message);
  }
}

function getSummary() {
  const date = elDate.value;
  const type = elType.value;
  const district = elDistrict.value;
  const rows = [];
  let total = 0;

  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    const people = getCategoryPeople(district, cat);
    if (people.length === 0) return;
    const cnt = people.filter((person) => personIsPresent(workingRecord, person, district, cat)).length;
    total += cnt;
    rows.push({ key: cat.key, name: cat.name, count: cnt });
  });

  const d = new Date(date);
  const dateStr = `${String(d.getFullYear()).slice(2)}.${d.getMonth() + 1}.${d.getDate()}.`;
  return { district, dateStr, type, rows, total };
}

function buildShareText() {
  const s = getSummary();
  let text = `${s.district} ${s.dateStr} ${s.type} 참석인원\n\n`;

  if (s.rows.length === 0) {
    text += '명단이 등록되지 않았습니다.';
    return text;
  }

  s.rows.forEach((r) => {
    text += `${r.name} ${r.count}\n`;
  });

  text += `\n총 ${s.total}명 참석`;
  return text;
}

function openShare() {
  document.getElementById('share-preview').textContent = buildShareText();
  document.getElementById('image-preview-wrap').classList.remove('show');
  lastGeneratedImageBlob = null;
  document.getElementById('share-modal').classList.add('show');
}

function shareAsText() {
  const text = buildShareText();

  navigator.clipboard
    .writeText(text)
    .then(() => {
      alert('텍스트가 복사되었습니다.\n카톡방에 붙여넣기 해주세요.');
    })
    .catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();

      try {
        document.execCommand('copy');
        alert('텍스트가 복사되었습니다.');
      } catch (e) {
        alert('복사에 실패했습니다. 직접 복사해주세요.');
      }

      document.body.removeChild(ta);
    });
}

async function shareAsImage() {
  try {
    await ensureHtml2CanvasLibrary();
  } catch (err) {
    alert('이미지 생성 기능을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해주세요.');
    return;
  }
  const s = getSummary();
  const district = elDistrict.value;
  const card = document.getElementById('capture-card');

  document.getElementById('cap-title').textContent = `${s.district} ${s.type} 참석인원`;
  document.getElementById('cap-sub').textContent = s.dateStr;

  const catWrap = document.getElementById('cap-categories');
  catWrap.innerHTML = '';

  CAT_ORDER.forEach((k) => {
    const cat = CATEGORIES[k];
    const people = getCategoryPeople(district, cat);
    if (people.length === 0) return;

    const attended = people.filter((person) => personIsPresent(workingRecord, person, district, cat)).length;

    const section = document.createElement('div');
    section.className = 'cap-cat-section';

    const title = document.createElement('div');
    title.className = `cap-cat-title ${cat.btnClass}`;
    title.textContent = `${cat.name} ${attended}/${people.length}`;
    section.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'cap-name-grid';

    people.forEach((person) => {
      const btn = document.createElement('div');
      btn.className = `cap-name-btn ${cat.btnClass}`;
      if (personIsPresent(workingRecord, person, district, cat)) btn.classList.add('active');
      btn.textContent = person.name;
      grid.appendChild(btn);
    });

    section.appendChild(grid);
    catWrap.appendChild(section);
  });

  document.getElementById('cap-total').textContent = `총 ${s.total}명 참석`;

  card.style.top = '0';
  card.style.left = '0';
  card.style.zIndex = '-1';

  html2canvas(card, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
    .then((canvas) => {
      card.style.top = '-9999px';
      card.style.left = '-9999px';

      canvas.toBlob((blob) => {
        if (!blob) {
          alert('이미지 생성에 실패했습니다.');
          return;
        }

        lastGeneratedImageBlob = blob;
        lastGeneratedImageFilename = `출석_${s.district}_${s.dateStr.replace(/\./g, '')}.png`;
        document.getElementById('image-preview').src = canvas.toDataURL('image/png');
        document.getElementById('image-preview-wrap').classList.add('show');
      }, 'image/png');
    })
    .catch((err) => {
      card.style.top = '-9999px';
      card.style.left = '-9999px';
      alert('이미지 생성에 실패했습니다: ' + err.message);
    });
}

function downloadImage() {
  if (!lastGeneratedImageBlob) {
    alert('먼저 [이미지 만들기]를 눌러주세요.');
    return;
  }

  const file = new File([lastGeneratedImageBlob], lastGeneratedImageFilename, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: '구역 출석' }).catch(() => fallbackDownload());
  } else {
    fallbackDownload();
  }
}

function fallbackDownload() {
  const url = URL.createObjectURL(lastGeneratedImageBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = lastGeneratedImageFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function newVolunteerForm() {
  return { name: '', phone: '', cat: '', cells: {} };
}

function cloneVolunteerPerson(person) {
  return {
    name: String(person?.name || ''),
    phone: String(person?.phone || ''),
    cat: String(person?.cat || ''),
    cells: Object.assign({}, person?.cells || {}),
  };
}

function saveVolunteerState() {
  localStorage.setItem(STORAGE_KEY_VOLUNTEER_STATE, JSON.stringify(volunteerState));
}

function getVolunteerDistrictNumber() {
  const raw = normalizeNameValue(elVolunteerDistrict.value);
  const digits = raw.replace(/[^0-9]/g, '');
  return digits || raw.replace(/구역/g, '').trim();
}

function getVolunteerDistrictLabel() {
  const district = getVolunteerDistrictNumber();
  if (!district) return '';
  return district.endsWith('구역') ? district : `${district}구역`;
}

function saveVolunteerDistrict() {
  const district = getVolunteerDistrictNumber();
  if (district) {
    elVolunteerDistrict.value = district;
    localStorage.setItem(STORAGE_KEY_VOLUNTEER_DISTRICT, district);
  }
}

function initVolunteerDistrict() {
  const saved = localStorage.getItem(STORAGE_KEY_VOLUNTEER_DISTRICT);
  const current = String(elDistrict.value || '').replace(/[^0-9]/g, '');
  elVolunteerDistrict.value = saved || current || '11';
}

function initVolunteerUi() {
  if (volunteerUiReady) return;
  volunteerUiReady = true;
  initVolunteerDistrict();

  const daysWrap = document.getElementById('volunteer-days');
  daysWrap.innerHTML = '';
  VOLUNTEER_DAYS.forEach((day) => {
    const dayBox = document.createElement('div');
    dayBox.className = 'volunteer-day';
    const selectableSlots = day.slots.filter((slot) => !slot.mark);
    const dayAll =
      selectableSlots.length > 1
        ? `<button class="volunteer-day-all" data-day="${day.date}" type="button">하루 종일</button>`
        : '';
    const chips = day.slots
      .map((slot) => {
        const cls = `volunteer-chip volunteer-slot ${slot.mark ? 'mark' : slot.f || ''}`;
        return `<button class="${cls}" data-col="${slot.c}" type="button"><i></i>${slot.t}</button>`;
      })
      .join('');

    dayBox.innerHTML = `
                <div class="volunteer-day-head">
                    <span class="volunteer-day-date">${day.date}</span>
                    <span class="volunteer-day-dow">${day.dow}</span>
                    ${dayAll}
                </div>
                <div class="volunteer-chip-row">${chips}</div>`;
    daysWrap.appendChild(dayBox);
  });

  const vehicleWrap = document.getElementById('volunteer-vehicles');
  vehicleWrap.innerHTML = '';
  VOLUNTEER_VEHICLES.forEach((group) => {
    const box = document.createElement('div');
    box.className = 'volunteer-vehicle-box';
    box.innerHTML = `<b>${group.title}</b><div class="volunteer-chip-row">${group.items
      .map(
        (item) =>
          `<button class="volunteer-chip volunteer-vehicle" data-col="${item.c}" type="button"><i></i>${item.t}</button>`,
      )
      .join('')}</div>`;
    vehicleWrap.appendChild(box);
  });

  syncVolunteerForm();
  renderVolunteerRoster();
  refreshIcons();
}

function syncVolunteerForm() {
  elVolunteerName.value = volunteerState.form.name;
  elVolunteerPhone.value = volunteerState.form.phone;

  document.querySelectorAll('.volunteer-category').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.cat === volunteerState.form.cat);
  });

  document.querySelectorAll('.volunteer-slot, .volunteer-vehicle').forEach((chip) => {
    chip.classList.toggle('active', !!volunteerState.form.cells[chip.dataset.col]);
  });

  updateVolunteerCount();
  saveVolunteerState();
}

function volunteerFormHasData() {
  return !!(
    volunteerState.form.name.trim() ||
    volunteerState.form.phone.trim() ||
    volunteerState.form.cat ||
    Object.keys(volunteerState.form.cells).length
  );
}

function collectVolunteerPeople() {
  const people = volunteerState.roster.map(cloneVolunteerPerson);
  if (volunteerState.form.name.trim()) people.push(cloneVolunteerPerson(volunteerState.form));
  return people;
}

function updateVolunteerCount() {
  const count = volunteerState.roster.length + (volunteerState.form.name.trim() ? 1 : 0);
  document.getElementById('volunteer-count').textContent = `${count}명`;
}

function getVolunteerPersonSummary(person) {
  const days = [];
  VOLUNTEER_DAYS.forEach((day) => {
    if (day.slots.some((slot) => person.cells[slot.c])) days.push(day.date);
  });
  const vehicleCount = ['Y', 'Z', 'AA', 'AB'].filter((col) => person.cells[col]).length;
  const parts = [person.cat || '구분없음'];
  if (days.length) parts.push(days.join(', '));
  if (vehicleCount) parts.push(`차량 ${vehicleCount}`);
  return parts.join(' · ');
}

function renderVolunteerRoster() {
  const wrap = document.getElementById('volunteer-roster-wrap');
  const list = document.getElementById('volunteer-roster');

  if (!volunteerState.roster.length) {
    wrap.classList.remove('show');
    list.innerHTML = '';
    updateVolunteerCount();
    saveVolunteerState();
    return;
  }

  wrap.classList.add('show');
  list.innerHTML = '';
  volunteerState.roster.forEach((person, index) => {
    const item = document.createElement('div');
    item.className = 'volunteer-person';
    item.innerHTML = `
                <div class="volunteer-avatar">${escapeHtml((person.name || '?').slice(0, 1))}</div>
                <div class="volunteer-person-info">
                    <b>${escapeHtml(person.name || '이름없음')}</b>
                    <small>${escapeHtml(getVolunteerPersonSummary(person))}</small>
                </div>
                <div class="volunteer-person-actions">
                    <button data-volunteer-edit="${index}" type="button">수정</button>
                    <button class="danger" data-volunteer-delete="${index}" type="button">삭제</button>
                </div>`;
    list.appendChild(item);
  });
  updateVolunteerCount();
  saveVolunteerState();
}

function addVolunteerPerson() {
  if (!elVolunteerName.value.trim()) {
    alert('봉사자 이름을 입력해주세요.');
    elVolunteerName.focus();
    return;
  }

  volunteerState.form.name = elVolunteerName.value.trim();
  volunteerState.form.phone = elVolunteerPhone.value.trim();
  volunteerState.roster.push(cloneVolunteerPerson(volunteerState.form));
  volunteerState.form = newVolunteerForm();
  syncVolunteerForm();
  renderVolunteerRoster();
  elVolunteerName.focus();
}

function resetVolunteerCurrentForm() {
  if (volunteerFormHasData() && !confirm('현재 입력 중인 봉사자 내용을 초기화할까요?')) return;
  volunteerState.form = newVolunteerForm();
  syncVolunteerForm();
}

function handleVolunteerClick(event) {
  const target = event.target.closest(
    '.volunteer-category, .volunteer-slot, .volunteer-vehicle, .volunteer-day-all, [data-volunteer-edit], [data-volunteer-delete]',
  );
  if (!target || !elVolunteerSection.contains(target)) return;

  if (target.classList.contains('volunteer-category')) {
    const wasActive = target.classList.contains('active');
    document.querySelectorAll('.volunteer-category').forEach((chip) => chip.classList.remove('active'));
    volunteerState.form.cat = wasActive ? '' : target.dataset.cat;
    if (!wasActive) target.classList.add('active');
    updateVolunteerCount();
    saveVolunteerState();
    return;
  }

  if (target.classList.contains('volunteer-day-all')) {
    const day = VOLUNTEER_DAYS.find((item) => item.date === target.dataset.day);
    if (!day) return;
    const slots = day.slots.filter((slot) => !slot.mark);
    const allOn = slots.every((slot) => volunteerState.form.cells[slot.c]);
    slots.forEach((slot) => {
      if (allOn) delete volunteerState.form.cells[slot.c];
      else volunteerState.form.cells[slot.c] = 1;
    });
    syncVolunteerForm();
    return;
  }

  if (target.classList.contains('volunteer-slot') || target.classList.contains('volunteer-vehicle')) {
    const col = target.dataset.col;
    if (volunteerState.form.cells[col]) delete volunteerState.form.cells[col];
    else volunteerState.form.cells[col] = 1;
    target.classList.toggle('active', !!volunteerState.form.cells[col]);
    saveVolunteerState();
    return;
  }

  const editIndex = target.getAttribute('data-volunteer-edit');
  if (editIndex !== null) {
    volunteerState.form = cloneVolunteerPerson(volunteerState.roster[Number(editIndex)]);
    volunteerState.roster.splice(Number(editIndex), 1);
    renderVolunteerRoster();
    syncVolunteerForm();
    elVolunteerName.focus();
    return;
  }

  const deleteIndex = target.getAttribute('data-volunteer-delete');
  if (deleteIndex !== null) {
    volunteerState.roster.splice(Number(deleteIndex), 1);
    renderVolunteerRoster();
  }
}

function getVolunteerPreviewSlotClass(slot) {
  if (slot.mark) return 'fill-mark';
  if (slot.f === 'morning') return 'fill-morning';
  if (slot.f === 'afternoon') return 'fill-afternoon';
  if (slot.f === 'night') return 'fill-night';
  return '';
}

function volunteerEncodeCol(index) {
  let label = '';
  let current = index;
  while (current >= 0) {
    label = String.fromCharCode((current % 26) + 65) + label;
    current = Math.floor(current / 26) - 1;
  }
  return label;
}

function buildVolunteerPreviewHtml() {
  const districtLabel = getVolunteerDistrictLabel() || '구역';
  const people = collectVolunteerPeople();
  let html = `<table class="volunteer-preview-table">
            <thead>
                <tr class="title-row"><th colspan="28">* ${escapeHtml(districtLabel)} 봉사자 일자별 참석 파악 *</th></tr>
                <tr class="memo-row"><th colspan="28">(${escapeHtml(districtLabel)}) 입력상황</th></tr>
                <tr>
                    <th rowspan="3">No</th><th rowspan="3">성명</th><th rowspan="3">휴대폰</th><th>구분</th>`;

  VOLUNTEER_DAYS.forEach((day) => {
    html += `<th colspan="${day.slots.length}">${escapeHtml(day.date)}(${escapeHtml(day.dow)})</th>`;
  });
  html += `<th colspan="4">차량이용</th></tr><tr><th>봉/어</th>`;

  VOLUNTEER_DAYS.forEach((day) => {
    day.slots.forEach((slot) => {
      html += `<th rowspan="2" class="${getVolunteerPreviewSlotClass(slot)}">${escapeHtml(slot.t)}</th>`;
    });
  });

  html += `<th colspan="2">개인차이용</th><th colspan="2">교회차이용</th></tr>
            <tr><th>청년BS</th><th>갈때</th><th>올때</th><th>갈때</th><th>올때</th></tr>
            </thead><tbody>`;

  for (let i = 0; i < 17; i++) {
    const person = people[i];
    html += `<tr>
                <td>${i + 1}</td>
                <td>${escapeHtml(person ? person.name : '')}</td>
                <td>${escapeHtml(person ? person.phone : '')}</td>
                <td>${escapeHtml(person ? person.cat : '')}</td>`;
    for (let colIndex = 4; colIndex <= 27; colIndex++) {
      const col = volunteerEncodeCol(colIndex);
      html += `<td>${person && person.cells[col] ? '1' : ''}</td>`;
    }
    html += '</tr>';
  }

  html += `</tbody></table>`;
  return html;
}

function openVolunteerPreview() {
  document.getElementById('volunteer-preview-wrap').innerHTML = buildVolunteerPreviewHtml();
  document.getElementById('volunteer-preview-modal').classList.add('show');
}

function buildVolunteerWorkbook() {
  if (!window.XLSX) throw new Error('엑셀 기능을 아직 불러오지 못했습니다.');

  const district = getVolunteerDistrictNumber();
  if (!district) throw new Error('구역을 입력해주세요.');

  const people = collectVolunteerPeople();
  if (!people.length) throw new Error('봉사자 정보를 입력해주세요.');
  if (people.length > 17) throw new Error('한 파일에는 17명까지 가능합니다.');

  const U = XLSX.utils;
  const encCell = U.encode_cell;
  const encCol = U.encode_col;
  const decCol = U.decode_col;
  const ws = {};
  const merges = [];
  const fontName = '맑은 고딕';
  const borderLine = { style: 'thin', color: { rgb: 'D9E3F0' } };
  const border = { top: borderLine, bottom: borderLine, left: borderLine, right: borderLine };
  const center = { horizontal: 'center', vertical: 'center', wrapText: true };
  const districtLabel = `${district}구역`;

  function setCell(row, col, value, style) {
    ws[encCell({ r: row, c: col })] = {
      v: value === undefined ? '' : value,
      t: typeof value === 'number' ? 'n' : 's',
      s: style,
    };
  }

  function headerStyle(fillKey) {
    return {
      font: { name: fontName, sz: 9, bold: !fillKey },
      alignment: center,
      border,
      fill: fillKey ? { patternType: 'solid', fgColor: { rgb: VOLUNTEER_FILL[fillKey] } } : undefined,
    };
  }

  setCell(0, 0, `* ${districtLabel} 봉사자 일자별 참석 파악 *`, {
    font: { name: fontName, sz: 18, bold: true },
    alignment: center,
  });
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 27 } });
  setCell(1, 0, `  ( ${district} ) 구역`, {
    font: { name: fontName, sz: 11 },
    alignment: { horizontal: 'left', vertical: 'center' },
  });
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: 23 } });

  ['No', '성명', '휴대폰'].forEach((label, index) => {
    setCell(2, index, label, headerStyle());
    merges.push({ s: { r: 2, c: index }, e: { r: 4, c: index } });
  });

  setCell(2, 3, '구분', headerStyle());
  setCell(3, 3, '봉/어', headerStyle());
  setCell(4, 3, '청년BS', headerStyle());

  VOLUNTEER_DAYS.forEach((day) => {
    const cols = day.slots.map((slot) => decCol(slot.c));
    const min = Math.min.apply(null, cols);
    const max = Math.max.apply(null, cols);
    setCell(2, min, `${day.date}(${day.dow})`, headerStyle());
    if (max > min) merges.push({ s: { r: 2, c: min }, e: { r: 2, c: max } });

    day.slots.forEach((slot) => {
      const col = decCol(slot.c);
      setCell(3, col, slot.mark ? slot.t : slot.t.replace('~', '\n'), headerStyle(slot.f));
      merges.push({ s: { r: 3, c: col }, e: { r: 4, c: col } });
    });
  });

  setCell(2, decCol('Y'), '차량이용', headerStyle());
  merges.push({ s: { r: 2, c: decCol('Y') }, e: { r: 2, c: decCol('AB') } });
  setCell(3, decCol('Y'), '개인차이용', headerStyle());
  merges.push({ s: { r: 3, c: decCol('Y') }, e: { r: 3, c: decCol('Z') } });
  setCell(3, decCol('AA'), '교회차이용', headerStyle());
  merges.push({ s: { r: 3, c: decCol('AA') }, e: { r: 3, c: decCol('AB') } });
  setCell(4, decCol('Y'), '갈때', headerStyle());
  setCell(4, decCol('Z'), '올때', headerStyle());
  setCell(4, decCol('AA'), '갈때', headerStyle());
  setCell(4, decCol('AB'), '올때', headerStyle());

  const dataStyle = { font: { name: fontName, sz: 10 }, alignment: center, border };
  for (let i = 0; i < 17; i++) {
    const row = 5 + i;
    const person = people[i];
    setCell(row, 0, i + 1, dataStyle);
    setCell(row, 1, person ? person.name : '', dataStyle);
    setCell(row, 2, person ? person.phone : '', dataStyle);
    setCell(row, 3, person ? person.cat : '', dataStyle);
    for (let col = 4; col <= 27; col++) {
      const key = encCol(col);
      setCell(row, col, person && person.cells[key] ? 1 : '', dataStyle);
    }
  }

  const noteStyle = {
    font: { name: fontName, sz: 9 },
    alignment: { horizontal: 'left', vertical: 'center' },
  };
  [
    ' * 참석 차수를 기재하시고, 봉사 가능한 일자와 시간대에 숫자 "1"로 표시 합니다.',
    ' * 차량이용란은 봉사자들의 차량을 원활하게 지원하기 위한 것이니 숫자 "1"로 해당사항에 체크해주세요.',
    ' * 파일로 제출 기한 내 제출하여 주시기 바랍니다.',
  ].forEach((note, index) => {
    const row = 22 + index;
    setCell(row, 0, note, noteStyle);
    merges.push({ s: { r: row, c: 0 }, e: { r: row, c: 23 } });
  });

  ws['!ref'] = 'A1:AB25';
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 4 }, { wch: 9 }, { wch: 14 }, { wch: 8 }, { wch: 6.5 }, { wch: 5 }];
  for (let i = 0; i < 18; i++) ws['!cols'].push({ wch: 3.4 });
  ws['!cols'].push({ wch: 8 }, { wch: 5.2 }, { wch: 5.2 }, { wch: 5.2 }, { wch: 5.2 });
  ws['!rows'] = [{ hpt: 27 }, { hpt: 21 }, { hpt: 30 }, { hpt: 17 }, { hpt: 18 }];
  for (let i = 0; i < 17; i++) ws['!rows'].push({ hpt: 20 });

  const wb = U.book_new();
  U.book_append_sheet(wb, ws, districtLabel);
  return { wb, districtLabel };
}

async function exportVolunteerWorkbook() {
  try {
    await ensureXlsxLibrary();
    saveVolunteerDistrict();
    const { wb, districtLabel } = buildVolunteerWorkbook();
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true, compression: true });
    const mmdd = `${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
    const blob = new Blob([out], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    downloadBlobFile(blob, `${districtLabel}_봉사자참석_${mmdd}.xlsx`, '하계수양회 봉사자 참석');
  } catch (err) {
    alert(err.message || '엑셀 생성 중 오류가 발생했습니다.');
  }
}

function openVolunteerSection() {
  initVolunteerUi();
  document.querySelectorAll('.modal').forEach((m) => m.classList.remove('show'));

  const prayerSection = document.getElementById('prayer-section');
  if (prayerSection) prayerSection.classList.remove('show');
  if (elMonthlyActivityCard) elMonthlyActivityCard.style.display = 'none';

  elAttendance.style.display = 'none';
  elRecordStatusWrap.style.display = 'none';
  elSaveIndicator.style.display = 'none';

  const saveActions = document.querySelector('.save-bottom-actions');
  if (saveActions) saveActions.style.display = 'none';

  elVolunteerSection.classList.add('show');
  setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 80);
  refreshIcons();
}

function getPrayerDistrict() {
  return elPrayerDistrict.value || elDistrict.value || '11구역';
}

function getPrayerDistrictNumberText(district = getPrayerDistrict()) {
  return String(district || '').replace(/[^0-9]/g, '') || district || '';
}

function getPrayerList(district = getPrayerDistrict()) {
  const d = district;
  if (!allPrayerData[d]) allPrayerData[d] = [];
  return allPrayerData[d];
}

function selectPrayerDistrict(district) {
  if (!district) return;
  elPrayerDistrict.value = district;
  elPrayerImageDistrict.value = district;
  localStorage.setItem(STORAGE_KEY_PRAYER_DISTRICT, district);
  renderPrayerList();
}

function savePrayerData() {
  localStorage.setItem(STORAGE_KEY_PRAYERS, JSON.stringify(allPrayerData));
}

function normalizePrayerItem(item = {}) {
  return {
    district: normalizeNameValue(item.district || getPrayerDistrictNumberText()),
    leader: normalizeNameValue(item.leader),
    name: normalizeNameValue(item.name),
    relation: normalizeNameValue(item.relation),
    method: normalizeNameValue(item.method || '온라인/교회/대전도집회/DVD집회'),
    region: normalizeNameValue(item.region || '광주'),
    status: normalizeNameValue(item.status || '시작'),
    note: normalizeNameValue(item.note),
  };
}

function showHomePage() {
  document.querySelectorAll('.modal').forEach((m) => m.classList.remove('show'));

  const prayerSection = document.getElementById('prayer-section');
  if (prayerSection) prayerSection.classList.remove('show');
  if (elVolunteerSection) elVolunteerSection.classList.remove('show');
  if (elMonthlyActivityCard) elMonthlyActivityCard.style.display = '';

  elAttendance.style.display = '';
  elRecordStatusWrap.style.display = '';
  elSaveIndicator.style.display = '';

  const saveActions = document.querySelector('.save-bottom-actions');
  if (saveActions) saveActions.style.display = '';

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openPrayerSection() {
  const section = document.getElementById('prayer-section');
  if (elVolunteerSection) elVolunteerSection.classList.remove('show');
  if (elMonthlyActivityCard) elMonthlyActivityCard.style.display = 'none';

  elAttendance.style.display = 'none';
  elRecordStatusWrap.style.display = 'none';
  elSaveIndicator.style.display = 'none';

  const saveActions = document.querySelector('.save-bottom-actions');
  if (saveActions) saveActions.style.display = 'none';

  section.classList.add('show');
  renderPrayerList();

  setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 80);
}

function addPrayerMember() {
  const list = getPrayerList();
  list.push(normalizePrayerItem({}));
  savePrayerData();
  renderPrayerList();
}

function updatePrayerField(index, field, value) {
  const list = getPrayerList();
  if (!list[index]) return;
  list[index][field] = normalizeNameValue(value);
  if (field !== 'district' && !list[index].district) list[index].district = getPrayerDistrictNumberText();
  savePrayerData();
  updatePrayerCount();
}

function deletePrayerMember(index) {
  const list = getPrayerList();
  const item = list[index];
  if (!item) return;
  const nameText = item.name ? `「${item.name}」` : '이 항목';
  if (!confirm(`${nameText}을 삭제할까요?`)) return;
  list.splice(index, 1);
  savePrayerData();
  renderPrayerList();
}

function updatePrayerCount() {
  const list = getPrayerList();
  const el = document.getElementById('prayer-count');
  if (el) el.textContent = `${list.length}명`;
}

function renderPrayerList() {
  const tbody = document.getElementById('prayer-tbody');
  if (!tbody) return;

  const list = getPrayerList();
  updatePrayerCount();
  tbody.innerHTML = '';

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="prayer-empty">아직 등록된 기도명단이 없습니다. [명단 추가] 또는 [엑셀 업로드]를 이용해주세요.</div></td></tr>`;
    return;
  }

  list.forEach((raw, idx) => {
    const item = normalizePrayerItem(raw);
    list[idx] = item;
    const tr = document.createElement('tr');
    tr.innerHTML = `
                <td class="no-cell">${idx + 1}</td>
                <td class="district-cell"><input class="prayer-input" value="${escapeAttr(item.district)}" data-field="district"></td>
                <td><input class="prayer-input" value="${escapeAttr(item.leader)}" data-field="leader" placeholder="인도자"></td>
                <td><input class="prayer-input" value="${escapeAttr(item.name)}" data-field="name" placeholder="성명"></td>
                <td><input class="prayer-input" value="${escapeAttr(item.relation)}" data-field="relation" placeholder="관계"></td>
                <td><input class="prayer-input method" value="${escapeAttr(item.method)}" data-field="method" placeholder="방법"></td>
                <td><input class="prayer-input" value="${escapeAttr(item.region)}" data-field="region" placeholder="지역"></td>
                <td><input class="prayer-input" value="${escapeAttr(item.status)}" data-field="status" placeholder="상황"></td>
                <td><input class="prayer-input note" value="${escapeAttr(item.note)}" data-field="note" placeholder="비고"></td>
                <td><button class="prayer-delete-btn" type="button">삭제</button></td>`;

    tr.querySelectorAll('.prayer-input').forEach((input) => {
      input.addEventListener('change', () => updatePrayerField(idx, input.dataset.field, input.value));
      input.addEventListener('blur', () => updatePrayerField(idx, input.dataset.field, input.value));
    });
    tr.querySelector('.prayer-delete-btn').addEventListener('click', () => deletePrayerMember(idx));
    tbody.appendChild(tr);
  });

  savePrayerData();
}

function escapeAttr(value) {
  return escapeAttribute(value);
}

function getPrayerHeaderRowIndex(rows) {
  return rows.findIndex((row) => {
    const cols = row.map((c) => normalizeNameValue(c).replace(/\s/g, ''));
    return cols.includes('성명') && (cols.includes('인도자') || cols.includes('방법'));
  });
}

function parsePrayerRows(rows) {
  const cleanedRows = rows
    .map((row) => row.map((cell) => normalizeNameValue(cell)))
    .filter((row) => row.some((cell) => cell.length > 0));

  if (cleanedRows.length === 0) return [];

  const headerRowIndex = getPrayerHeaderRowIndex(cleanedRows);
  if (headerRowIndex < 0) return [];

  const headers = cleanedRows[headerRowIndex].map((h) => h.replace(/\s/g, ''));
  const dataRows = cleanedRows.slice(headerRowIndex + 1);

  const idx = {
    district: findHeaderIndex(headers, ['구역']),
    leader: findHeaderIndex(headers, ['인도자']),
    name: findHeaderIndex(headers, ['성명', '이름']),
    relation: findHeaderIndex(headers, ['관계']),
    method: findHeaderIndex(headers, ['방법']),
    region: findHeaderIndex(headers, ['지역']),
    status: findHeaderIndex(headers, ['상황', '상태']),
    note: findHeaderIndex(headers, ['비고', '메모']),
  };

  if (idx.name < 0) return [];

  const result = [];
  dataRows.forEach((row) => {
    const name = normalizeNameValue(row[idx.name]);
    const leader = idx.leader >= 0 ? normalizeNameValue(row[idx.leader]) : '';
    if (!name && !leader) return;

    result.push(
      normalizePrayerItem({
        district: idx.district >= 0 ? row[idx.district] : getPrayerDistrictNumberText(),
        leader,
        name,
        relation: idx.relation >= 0 ? row[idx.relation] : '',
        method: idx.method >= 0 ? row[idx.method] : '',
        region: idx.region >= 0 ? row[idx.region] : '',
        status: idx.status >= 0 ? row[idx.status] : '',
        note: idx.note >= 0 ? row[idx.note] : '',
      }),
    );
  });

  return result;
}

async function handlePrayerFileUpload(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const name = file.name.toLowerCase();

  try {
    let rows = [];
    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      const text = await readFileAsText(file);
      rows = parseCSVText(text.replace(/^\ufeff/, ''));
    } else {
      try {
        await ensureXlsxLibrary();
      } catch (loadErr) {
        alert('엑셀 읽기 기능을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
        return;
      }
      if (!window.XLSX) {
        alert('엑셀 읽기 기능을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
        return;
      }
      const buffer = await readFileAsArrayBuffer(file);
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    }

    const imported = parsePrayerRows(rows);
    if (imported.length === 0) {
      alert(
        '업로드할 기도명단을 찾지 못했습니다.\n엑셀의 제목 행에 번호, 구역, 인도자, 성명, 관계, 방법, 지역, 상황, 비고가 있는지 확인해주세요.',
      );
      return;
    }

    const current = getPrayerList();
    if (current.length > 0) {
      const ok = confirm(
        `${getPrayerDistrict()} 기존 기도명단 ${current.length}명을\n업로드 명단 ${imported.length}명으로 교체할까요?`,
      );
      if (!ok) return;
    }

    allPrayerData[getPrayerDistrict()] = imported;
    savePrayerData();
    openPrayerSection();
    alert(`기도명단 업로드 완료!\n총 ${imported.length}명이 등록되었습니다.`);
  } catch (err) {
    alert('기도명단 업로드에 실패했습니다: ' + err.message);
  }
}

function buildPrayerExportRows() {
  const list = getPrayerList();
  const now = new Date();
  const titleYear = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateText = `${titleYear}.${mm}.${dd}.`;
  const districtNum = getPrayerDistrictNumberText();

  const statusCount = getPrayerStatusCounts(list);

  const rows = [
    [`${titleYear}년 ${districtNum}구역 기도명단`, '', '', '', '', '', '', '', ''],
    [
      `기도명단 총인원 : ${list.length}명  (시작 : ${statusCount['시작']}명, 진행 : ${statusCount['진행']}명, 확정 : ${statusCount['확정']}명, 구원 : ${statusCount['구원']}명)`,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      dateText,
    ],
    ['번호', '구역', '인도자', '성명', '관계', '방법', '지역', '상황', '비고'],
  ];

  list.forEach((item, idx) => {
    rows.push([
      idx + 1,
      item.district || districtNum,
      item.leader || '',
      item.name || '',
      item.relation || '',
      item.method || '',
      item.region || '',
      item.status || '',
      item.note || '',
    ]);
  });

  return rows;
}

function getPrayerStatusCounts(list = getPrayerList()) {
  const counts = { 시작: 0, 진행: 0, 확정: 0, 구원: 0 };
  list.forEach((item) => {
    const status = normalizeNameValue(item.status);
    if (counts[status] !== undefined) counts[status]++;
  });
  return counts;
}

function getExcelCellStyle({
  fill,
  color = '26364D',
  bold = false,
  size = 10,
  horizontal = 'center',
  wrapText = true,
  border = true,
}) {
  const style = {
    font: { name: '맑은 고딕', sz: size, bold, color: { rgb: color } },
    fill: { patternType: 'solid', fgColor: { rgb: fill } },
    alignment: { horizontal, vertical: 'center', wrapText },
  };

  if (border) {
    style.border = {
      top: { style: 'thin', color: { rgb: 'D9E3F0' } },
      bottom: { style: 'thin', color: { rgb: 'D9E3F0' } },
      left: { style: 'thin', color: { rgb: 'D9E3F0' } },
      right: { style: 'thin', color: { rgb: 'D9E3F0' } },
    };
  }

  return style;
}

function ensureWorksheetCell(ws, row, col) {
  const address = XLSX.utils.encode_cell({ r: row, c: col });
  if (!ws[address]) ws[address] = { t: 's', v: '' };
  return ws[address];
}

function stylePrayerWorksheet(ws, rows) {
  const lastRow = rows.length - 1;
  const titleStyle = getExcelCellStyle({
    fill: '1B3A6B',
    color: 'FFFFFF',
    bold: true,
    size: 19,
    border: false,
  });
  const summaryStyle = getExcelCellStyle({
    fill: 'EAF3FF',
    color: '31557E',
    bold: true,
    size: 10,
    horizontal: 'left',
  });
  const dateStyle = getExcelCellStyle({
    fill: 'EAF3FF',
    color: '31557E',
    bold: true,
    size: 10,
    horizontal: 'right',
  });
  const headerStyle = getExcelCellStyle({ fill: '0B4FB3', color: 'FFFFFF', bold: true, size: 10 });
  const statusStyles = {
    시작: getExcelCellStyle({ fill: 'EAF3FF', color: '0B4FB3', bold: true }),
    진행: getExcelCellStyle({ fill: 'FFF4DB', color: 'A45D00', bold: true }),
    확정: getExcelCellStyle({ fill: 'EAFAF1', color: '168448', bold: true }),
    구원: getExcelCellStyle({ fill: 'F3EDFF', color: '7048C8', bold: true }),
  };

  for (let col = 0; col < 9; col++) {
    ensureWorksheetCell(ws, 0, col).s = titleStyle;
    ensureWorksheetCell(ws, 1, col).s = col === 8 ? dateStyle : summaryStyle;
    ensureWorksheetCell(ws, 2, col).s = headerStyle;
  }

  for (let row = 3; row <= lastRow; row++) {
    const fill = row % 2 === 1 ? 'FFFFFF' : 'F7FAFE';
    for (let col = 0; col < 9; col++) {
      const horizontal = col === 5 || col === 8 ? 'left' : 'center';
      const cell = ensureWorksheetCell(ws, row, col);
      cell.s = getExcelCellStyle({
        fill,
        color: col === 3 ? '1B3A6B' : '35465C',
        bold: col === 3,
        size: 10,
        horizontal,
      });
    }

    const statusCell = ensureWorksheetCell(ws, row, 7);
    const status = normalizeNameValue(statusCell.v);
    if (statusStyles[status]) statusCell.s = statusStyles[status];
  }

  ws['!rows'] = rows.map((_, idx) => ({ hpt: idx === 0 ? 34 : idx === 1 ? 25 : idx === 2 ? 27 : 42 }));
  ws['!autofilter'] = { ref: `A3:I${rows.length}` };
  ws['!freeze'] = { xSplit: 0, ySplit: 3, topLeftCell: 'A4', activePane: 'bottomLeft', state: 'frozen' };
  ws['!margins'] = { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 };
  ws['!pageSetup'] = { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  ws['!printOptions'] = { horizontalCentered: true, gridLines: false };
}

async function downloadPrayerTemplate() {
  try {
    await ensureXlsxLibrary();
  } catch (err) {
    console.warn('XLSX lazy load failed', err);
  }
  const districtNum = getPrayerDistrictNumberText();
  const rows = [
    [`${new Date().getFullYear()}년 ${districtNum}구역 기도명단`, '', '', '', '', '', '', '', ''],
    ['아래 제목 행은 변경하지 말고 명단을 입력한 뒤 업로드하세요.', '', '', '', '', '', '', '', ''],
    ['번호', '구역', '인도자', '성명', '관계', '방법', '지역', '상황', '비고'],
    [1, districtNum, '김인도', '홍길동', '가족', '온라인/교회/대전도집회/DVD집회', '광주', '시작', ''],
  ];

  if (!window.XLSX) {
    const csv =
      '\ufeff' +
      rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    downloadBlobFile(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      `${getPrayerDistrict()}_기도명단_업로드서식.csv`,
      '기도명단 CSV 서식',
    );
    return;
  }

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [
    { wch: 6 },
    { wch: 8 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 34 },
    { wch: 10 },
    { wch: 10 },
    { wch: 22 },
  ];
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } },
  ];
  stylePrayerWorksheet(sheet, rows);
  XLSX.utils.book_append_sheet(workbook, sheet, '기도명단');

  const buffer = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'array',
    cellStyles: true,
    compression: true,
  });
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlobFile(blob, `${getPrayerDistrict()}_기도명단_업로드서식.xlsx`, '기도명단 엑셀 서식');
}

async function exportPrayerList() {
  try {
    await ensureXlsxLibrary();
  } catch (err) {
    console.warn('XLSX lazy load failed', err);
  }
  const list = getPrayerList();
  if (list.length === 0) {
    alert('추출할 기도명단이 없습니다.');
    return;
  }

  const rows = buildPrayerExportRows();
  const fileName = `${getPrayerDistrict()}_기도명단.xlsx`;

  if (!window.XLSX) {
    const csv =
      '\ufeff' +
      rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlobFile(blob, `${getPrayerDistrict()}_기도명단.csv`);
    return;
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 6 },
    { wch: 8 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 34 },
    { wch: 10 },
    { wch: 10 },
    { wch: 22 },
  ];
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } },
  ];
  stylePrayerWorksheet(ws, rows);

  XLSX.utils.book_append_sheet(wb, ws, '기도명단');
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true, compression: true });
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlobFile(blob, fileName, `${getPrayerDistrict()} 기도명단`);
}

function getPrayerStatusClass(status) {
  const clean = normalizeNameValue(status);
  if (clean === '진행') return 'status-progress';
  if (clean === '확정') return 'status-confirmed';
  if (clean === '구원') return 'status-saved';
  return 'status-start';
}

function getPrayerImagePageSize() {
  return 45;
}

function isPrayerImageHighlight(item) {
  const method = normalizeNameValue(item.method);
  const status = normalizeNameValue(item.status || '시작');
  const defaultMethod = '온라인/교회/대전도집회/DVD집회';
  return status !== '시작' || (method && method !== defaultMethod);
}

function buildPrayerImagePage(items, startIndex, pageIndex, totalPages, district, fullList) {
  const page = document.createElement('div');
  page.className = 'prayer-capture-page';

  const now = new Date();
  const year = now.getFullYear();
  const dateText = `${year}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}.`;
  const counts = getPrayerStatusCounts(fullList);
  const districtNum = getPrayerDistrictNumberText(district);
  const titleDistrict = district || `${districtNum}구역`;

  const tableRows = items
    .map((raw, localIndex) => {
      const item = normalizePrayerItem(raw);
      const rowClass = isPrayerImageHighlight(item) ? 'pci-row-highlight' : '';
      const rowNo = startIndex + localIndex + 1;
      const statusClass = getPrayerStatusClass(item.status);

      return `
                <tr class="${rowClass}">
                    <td class="no-cell">${rowNo}</td>
                    <td class="district-cell">${escapeAttr(item.district || districtNum)}</td>
                    <td>${escapeAttr(item.leader)}</td>
                    <td class="name-cell">${escapeAttr(item.name)}</td>
                    <td>${escapeAttr(item.relation)}</td>
                    <td class="method-cell">${escapeAttr(item.method)}</td>
                    <td>${escapeAttr(item.region)}</td>
                    <td class="status-cell ${statusClass}">${escapeAttr(item.status || '시작')}</td>
                    <td class="note-cell">${escapeAttr(item.note)}</td>
                </tr>`;
    })
    .join('');

  page.innerHTML = `
            <div class="pci-titlebar">${year}년 ${escapeAttr(titleDistrict)} 기도명단</div>
            <div class="pci-summary-row">
                <div>○ 기도명단 총인원 : ${fullList.length}명&nbsp;&nbsp;(시작 : ${counts['시작']}명, 진행 : ${counts['진행']}명, 확정 : ${counts['확정']}명, 구원 : ${counts['구원']}명)</div>
                <div class="pci-summary-date">${dateText}</div>
            </div>
            <table class="pci-table">
                <colgroup>
                    <col class="col-no"><col class="col-district"><col class="col-leader"><col class="col-name"><col class="col-relation"><col class="col-method"><col class="col-region"><col class="col-status"><col class="col-note">
                </colgroup>
                <thead>
                    <tr>
                        <th>번호</th><th>구역</th><th>인도자</th><th>성명</th><th>관계</th><th>방법</th><th>지역</th><th>상황</th><th>비고</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
            <div class="pci-page-note">${pageIndex + 1} / ${totalPages}</div>`;

  return page;
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('이미지 변환에 실패했습니다.'))),
      'image/png',
    );
  });
}

function clearPrayerImageFiles() {
  prayerImageFiles.forEach((item) => {
    if (item.url) URL.revokeObjectURL(item.url);
  });
  prayerImageFiles = [];
}

function renderPrayerImageGallery() {
  const gallery = document.getElementById('prayer-image-gallery');
  gallery.innerHTML = '';

  prayerImageFiles.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'prayer-image-preview-card';
    card.innerHTML = `
                <img src="${item.url}" alt="기도명단 이미지 ${index + 1}">
                <div class="prayer-image-preview-actions">
                    <span>${index + 1} / ${prayerImageFiles.length} 페이지</span>
                    <button type="button">이 페이지만 저장</button>
                </div>`;
    card.querySelector('button').addEventListener('click', () => downloadPrayerImage(index));
    gallery.appendChild(card);
  });
}

function updatePrayerImageConfirmSummary() {
  const district = elPrayerImageDistrict.value || getPrayerDistrict();
  const count = getPrayerList(district).length;
  const pages = Math.ceil(count / getPrayerImagePageSize());
  const summary = document.getElementById('prayer-image-confirm-summary');
  const confirmButton = document.getElementById('btn-confirm-prayer-image');
  summary.innerHTML = `<strong>${escapeAttr(district)}</strong> · 총 ${count}명<br>${pages || 0}장의 이미지가 만들어집니다.`;
  confirmButton.textContent = `${district} 이미지 만들기`;
  confirmButton.disabled = count === 0;
}

function openPrayerImageConfirm() {
  elPrayerImageDistrict.value = getPrayerDistrict();
  updatePrayerImageConfirmSummary();
  document.getElementById('prayer-image-confirm-modal').classList.add('show');
}

function confirmPrayerImageExport() {
  const district = elPrayerImageDistrict.value;
  selectPrayerDistrict(district);
  document.getElementById('prayer-image-confirm-modal').classList.remove('show');
  exportPrayerImages(district);
}

async function exportPrayerImages(district = getPrayerDistrict()) {
  const list = getPrayerList(district);
  if (list.length === 0) {
    alert('추출할 기도명단이 없습니다.');
    return;
  }

  try {
    await ensureHtml2CanvasLibrary();
  } catch (err) {
    alert('이미지 생성 기능을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해주세요.');
    return;
  }

  if (!window.html2canvas) {
    alert('이미지 생성 기능을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
    return;
  }

  const button = document.getElementById('btn-export-prayer-image');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '이미지 만드는 중...';
  clearPrayerImageFiles();

  const root = document.getElementById('prayer-capture-root');
  root.innerHTML = '';
  root.style.top = '0';
  root.style.left = '0';
  lastPrayerImageDistrict = district;
  const pageSize = getPrayerImagePageSize();
  const totalPages = Math.ceil(list.length / pageSize);

  try {
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const startIndex = pageIndex * pageSize;
      const pageItems = list.slice(startIndex, startIndex + pageSize);
      const page = buildPrayerImagePage(pageItems, startIndex, pageIndex, totalPages, district, list);
      root.appendChild(page);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const canvas = await html2canvas(page, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
      });
      const blob = await canvasToPngBlob(canvas);
      const fileNumber = String(pageIndex + 1).padStart(2, '0');
      prayerImageFiles.push({
        blob,
        url: URL.createObjectURL(blob),
        filename: `${district}_기도명단_${fileNumber}.png`,
      });
      page.remove();
    }

    renderPrayerImageGallery();
    document.getElementById('prayer-image-modal').classList.add('show');
  } catch (err) {
    clearPrayerImageFiles();
    alert('기도명단 이미지 생성에 실패했습니다: ' + err.message);
  } finally {
    root.innerHTML = '';
    root.style.top = '-9999px';
    root.style.left = '-9999px';
    button.disabled = false;
    button.textContent = originalText;
  }
}

function downloadPrayerImage(index) {
  const item = prayerImageFiles[index];
  if (!item) return;
  const a = document.createElement('a');
  a.href = item.url;
  a.download = item.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function downloadAllPrayerImages() {
  if (prayerImageFiles.length === 0) {
    alert('먼저 모바일 이미지를 만들어주세요.');
    return;
  }

  const files = prayerImageFiles.map((item) => new File([item.blob], item.filename, { type: 'image/png' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    navigator
      .share({ files, title: `${lastPrayerImageDistrict || getPrayerDistrict()} 기도명단` })
      .catch((err) => {
        if (err.name !== 'AbortError')
          prayerImageFiles.forEach((_, idx) => setTimeout(() => downloadPrayerImage(idx), idx * 350));
      });
    return;
  }

  prayerImageFiles.forEach((_, idx) => setTimeout(() => downloadPrayerImage(idx), idx * 350));
}

function renderStats() {
  const records = getRecords();
  const district = elDistrict.value;
  const container = document.getElementById('stats-container');
  container.innerHTML = '';

  const dates = getValidRecordDates(records);

  if (dates.length === 0) {
    container.innerHTML =
      '<div class="empty-msg">아직 저장된 출석 기록이 없습니다.<br>출석체크 후 저장하기를 눌러주세요.</div>';
    return;
  }

  const monthSelect = document.getElementById('stats-month-select');
  const months = [...new Set(dates.map((d) => d.substring(0, 7)))].sort().reverse();

  if (monthSelect) {
    const prev = currentStatsMonth || monthSelect.value || 'all';
    monthSelect.innerHTML = '<option value="all">전체통계</option>';

    months.forEach((ym) => {
      const [y, m] = ym.split('-');
      monthSelect.innerHTML += `<option value="${ym}">${y}년 ${parseInt(m, 10)}월</option>`;
    });

    if ([...monthSelect.options].some((o) => o.value === prev)) monthSelect.value = prev;
    else monthSelect.value = 'all';

    currentStatsMonth = monthSelect.value;
  }

  const selectedType = currentStatsType;
  const selectedMonth = currentStatsMonth || 'all';

  const headerInfo = document.createElement('div');
  headerInfo.style.cssText = `background:${TYPE_BG[selectedType]};padding:10px 12px;border-radius:8px;margin-bottom:15px;font-size:0.9rem;color:${TYPE_COLOR[selectedType]};`;
  headerInfo.innerHTML = `<b>${elDistrict.value} · ${selectedType}</b> ${selectedMonth === 'all' ? '전체통계' : '선택 월'} 범주별 평균 출석`;
  container.appendChild(headerInfo);

  const periodMap = {};
  let hasAnyData = false;

  dates.forEach((date) => {
    if (selectedMonth !== 'all' && !date.startsWith(selectedMonth)) return;

    const dayRec = records[date];
    if (!dayRec || !dayRec[selectedType]) return;

    const key = selectedMonth === 'all' ? 'all' : date.substring(0, 7);
    if (!periodMap[key]) periodMap[key] = { eun: [], bong: [], mom: [], youth: [] };

    const attendees = dayRec[selectedType];

    CAT_ORDER.forEach((k) => {
      const cat = CATEGORIES[k];
      const people = getCategoryPeople(district, cat);
      periodMap[key][cat.key].push(
        people.filter((person) => personIsPresent(attendees, person, district, cat)).length,
      );
    });

    hasAnyData = true;
  });

  if (!hasAnyData) {
    container.innerHTML += `<div class="empty-msg">${selectedType} 기록이 아직 없습니다.</div>`;
    return;
  }

  const periodKeys = selectedMonth === 'all' ? ['all'] : Object.keys(periodMap).sort().reverse();

  periodKeys.forEach((key) => {
    const sessionCount = periodMap[key].eun.length;

    const monthTitle = document.createElement('div');
    monthTitle.className = 'stats-month-title';

    if (key === 'all') {
      monthTitle.textContent = `전체 기간 (${sessionCount}회 진행)`;
    } else {
      const [y, m] = key.split('-');
      monthTitle.textContent = `${y}년 ${parseInt(m, 10)}월 (${sessionCount}회 진행)`;
    }

    container.appendChild(monthTitle);

    const table = document.createElement('table');
    table.className = 'stats-table';
    table.innerHTML = `<thead><tr><th>범주</th><th>전체</th><th>평균 출석</th><th>출석률</th></tr></thead>`;

    const tbody = document.createElement('tbody');
    let periodTotalAvg = 0;
    let periodTotalMembers = 0;

    CAT_ORDER.forEach((k) => {
      const cat = CATEGORIES[k];
      const people = getCategoryPeople(district, cat);
      const counts = periodMap[key][cat.key];
      const tr = document.createElement('tr');

      if (people.length === 0) {
        tr.innerHTML = `<td style="color:#bbb;">${cat.name}</td><td colspan="3" style="color:#bbb;">명단없음</td>`;
      } else if (!counts || counts.length === 0) {
        tr.innerHTML = `<td>${cat.name}</td><td>${people.length}명</td><td style="color:#bbb;">0.0명</td><td>0%</td>`;
      } else {
        const sum = counts.reduce((a, b) => a + b, 0);
        const avg = sum / counts.length;
        const rate = ((avg / people.length) * 100).toFixed(0);

        periodTotalAvg += avg;
        periodTotalMembers += people.length;

        tr.innerHTML = `<td>${cat.name}</td><td>${people.length}명</td><td><b>${avg.toFixed(1)}명</b></td><td>${rate}%</td>`;
      }

      tbody.appendChild(tr);
    });

    if (periodTotalMembers > 0) {
      const totalRow = document.createElement('tr');
      totalRow.style.cssText = 'background:#f8f9fa;font-weight:950;';
      totalRow.innerHTML = `<td>합계</td><td>${periodTotalMembers}명</td><td style="color:${TYPE_COLOR[selectedType]};">${periodTotalAvg.toFixed(1)}명</td><td>${((periodTotalAvg / periodTotalMembers) * 100).toFixed(0)}%</td>`;
      tbody.appendChild(totalRow);
    }

    table.appendChild(tbody);
    container.appendChild(table);
  });
}

function renderPersonalStats() {
  const records = getRecords();
  const district = elDistrict.value;
  const cat = CATEGORIES[currentPersonalCat];
  const people = getCategoryPeople(district, cat);
  const listEl = document.getElementById('personal-list');
  const detailEl = document.getElementById('personal-detail');

  detailEl.style.display = 'none';
  listEl.innerHTML = '';

  const allDates = getValidRecordDates(records, true);
  const months = [...new Set(allDates.map((d) => d.substring(0, 7)))];
  const sel = document.getElementById('personal-month-select');
  const prev = sel.value;

  sel.innerHTML = '<option value="all">전체 기간</option>';

  months.forEach((ym) => {
    const [y, m] = ym.split('-');
    sel.innerHTML += `<option value="${ym}">${y}년 ${parseInt(m, 10)}월</option>`;
  });

  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else sel.value = currentPersonalMonth;

  currentPersonalMonth = sel.value;

  if (people.length === 0) {
    listEl.innerHTML = `<div class="empty-msg">${cat.name} 명단이 없습니다.</div>`;
    return;
  }

  const filteredDates =
    currentPersonalMonth === 'all' ? allDates : allDates.filter((d) => d.startsWith(currentPersonalMonth));
  const memberStats = new Map();

  people.forEach((person) => {
    const key = ensureMemberId(person, district, cat.name);
    memberStats.set(key, {
      person,
      counts: { 주일말씀: 0, 수요말씀: 0, 구역모임: 0 },
      dates: { 주일말씀: [], 수요말씀: [], 구역모임: [] },
    });
  });

  const totalSessions = { 주일말씀: 0, 수요말씀: 0, 구역모임: 0 };

  filteredDates.forEach((date) => {
    const dayRec = records[date];
    if (!dayRec) return;

    ['주일말씀', '수요말씀', '구역모임'].forEach((t) => {
      if (!dayRec[t]) return;

      totalSessions[t]++;
      memberStats.forEach((stat) => {
        const present = personIsPresent(dayRec[t], stat.person, district, cat);
        if (present) stat.counts[t]++;
        stat.dates[t].push({ date, present });
      });
    });
  });

  const maxCount = totalSessions[currentPersonalType] || 1;
  const barCls = (c, t) =>
    !t ? 'bar-zero' : c / t >= 0.75 ? 'bar-high' : c / t >= 0.4 ? 'bar-mid' : 'bar-low';

  const info = document.createElement('div');
  info.style.cssText = 'text-align:center;font-size:0.82rem;color:#aaa;margin-bottom:10px;';
  info.textContent = `${currentPersonalType} 총 ${totalSessions[currentPersonalType]}회 진행`;
  listEl.appendChild(info);

  memberStats.forEach((stat) => {
    const name = stat.person.name;
    const count = stat.counts[currentPersonalType];
    const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;

    const row = document.createElement('div');
    row.className = `member-stat-row ${cat.rowClass}`;
    row.innerHTML = `
                <span class="member-stat-name">${escapeHtml(name)}</span>
                <div class="member-stat-bar-wrap">
                    <div class="member-stat-bar ${barCls(count, totalSessions[currentPersonalType])}" style="width:${pct}%;"></div>
                </div>
                <span class="member-stat-count">${count}/${totalSessions[currentPersonalType]}</span>`;

    row.addEventListener('click', () => showPersonalDetail(name, stat.counts, stat.dates, totalSessions));
    listEl.appendChild(row);
  });
}

function showPersonalDetail(name, counts, dates, totalSessions) {
  const detailEl = document.getElementById('personal-detail');
  const typeColors = { 주일말씀: '#c0392b', 수요말씀: '#8e44ad', 구역모임: '#4a90e2' };

  let dotsHTML = '';

  ['주일말씀', '수요말씀', '구역모임'].forEach((t) => {
    const list = dates[t];
    if (!list || list.length === 0) return;

    dotsHTML += `
                <div class="dot-section">
                    <div class="dot-section-label">${t}</div>
                    <div class="dot-section-inner">
                        ${list
                          .map(({ date, present }) => {
                            const d = new Date(date);
                            return `<div class="date-dot ${present ? 'present' : 'absent'}">${d.getMonth() + 1}/${d.getDate()}</div>`;
                          })
                          .join('')}
                    </div>
                </div>`;
  });

  detailEl.innerHTML = `
            <div class="personal-detail-box">
                <div class="personal-detail-title"><span>${escapeHtml(name)}</span><button class="personal-detail-close" type="button">✕</button></div>
                ${['주일말씀', '수요말씀', '구역모임']
                  .map((t) => {
                    const cnt = counts[t];
                    const tot = totalSessions[t] || 0;
                    const pct = tot > 0 ? (cnt / tot) * 100 : 0;
                    return `
                        <div class="personal-detail-row">
                            <span class="personal-detail-label">${t}</span>
                            <div class="personal-detail-bar-wrap">
                                <div class="personal-detail-bar" style="width:${pct}%;background:${typeColors[t]};"></div>
                            </div>
                            <span class="personal-detail-val">${cnt}회</span>
                        </div>`;
                  })
                  .join('')}
                ${dotsHTML}
                <div class="personal-summary">
                    <div class="ps-item"><div class="ps-val">${counts['주일말씀']}</div><div class="ps-label">주일 총출석</div></div>
                    <div class="ps-item"><div class="ps-val">${counts['수요말씀']}</div><div class="ps-label">수요 총출석</div></div>
                    <div class="ps-item"><div class="ps-val">${counts['구역모임']}</div><div class="ps-label">구역 총출석</div></div>
                </div>
            </div>`;

  detailEl.querySelector('.personal-detail-close')?.addEventListener('click', () => {
    detailEl.style.display = 'none';
  });

  detailEl.style.display = 'block';
  detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openStats() {
  document.querySelectorAll('.stats-main-tab').forEach((t) => t.classList.remove('active'));
  document.querySelector('.stats-main-tab[data-main="monthly"]').classList.add('active');
  document.getElementById('stats-monthly-wrap').style.display = 'block';
  document.getElementById('stats-personal-wrap').style.display = 'none';

  renderStats();
  document.getElementById('stats-modal').classList.add('show');
}

function showUpdateNotice() {
  if (localStorage.getItem(STORAGE_KEY_UPDATE_NOTICE) === APP_VERSION) return;
  localStorage.setItem(STORAGE_KEY_UPDATE_NOTICE, APP_VERSION);
  setTimeout(() => document.getElementById('update-modal').classList.add('show'), 350);
}

function confirmUpdateNotice() {
  document.getElementById('update-modal').classList.remove('show');
}

function getServerSyncedDistricts() {
  const raw = localStorage.getItem(STORAGE_KEY_SERVER_SYNCED_DISTRICTS);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function hasServerSyncedDistrict(district) {
  return !!getServerSyncedDistricts()[district];
}

function markServerSyncedDistrict(district) {
  const data = getServerSyncedDistricts();
  data[district] = true;
  localStorage.setItem(STORAGE_KEY_SERVER_SYNCED_DISTRICTS, JSON.stringify(data));
}

function getRemoteRecordDateAndType(item = {}) {
  const id = String(item.id || '');
  const firstUnderscore = id.indexOf('_');
  const idDate = firstUnderscore > -1 ? id.slice(0, firstUnderscore) : '';
  const idType = firstUnderscore > -1 ? id.slice(firstUnderscore + 1) : '';
  return {
    date: normalizeNameValue(item.날짜 || idDate),
    type: normalizeNameValue(item.모임 || idType),
  };
}

function getRemoteAttendanceNames(item = {}) {
  const data = item.출석데이터 || {};
  const tokens = [];

  Object.values(data).forEach((catData) => {
    if (!catData) return;
    if (Array.isArray(catData.출석ID) && catData.출석ID.length) tokens.push(...catData.출석ID.map(String));
    else if (Array.isArray(catData.출석)) tokens.push(...catData.출석);
  });

  return uniqueNames(tokens);
}

function buildLocalRecordsFromRemoteDocs(remoteDocs = []) {
  const remoteRecords = {};

  remoteDocs.forEach((item) => {
    const { date, type } = getRemoteRecordDateAndType(item);
    if (!isValidRecordDateKey(date) || !type) return;
    if (!remoteRecords[date]) remoteRecords[date] = {};
    remoteRecords[date][type] = getRemoteAttendanceNames(item);
  });

  return remoteRecords;
}

function cloneAttendanceRecords(records = {}) {
  const cloned = {};

  Object.entries(records || {}).forEach(([date, dayRecords]) => {
    if (!isValidRecordDateKey(date)) return;
    cloned[date] = {};

    Object.entries(dayRecords || {}).forEach(([type, record]) => {
      if (!Array.isArray(record)) return;
      cloned[date][type] = uniqueNames(record);
    });

    if (Object.keys(cloned[date]).length === 0) delete cloned[date];
  });

  return cloned;
}

function mergeFirstServerSyncRecords(localRecords = {}, remoteRecords = {}) {
  const merged = cloneAttendanceRecords(localRecords);

  Object.entries(remoteRecords || {}).forEach(([date, dayRecords]) => {
    if (!isValidRecordDateKey(date)) return;
    if (!merged[date]) merged[date] = {};

    Object.entries(dayRecords || {}).forEach(([type, record]) => {
      if (!Array.isArray(record)) return;
      merged[date][type] = uniqueNames(record);
    });
  });

  return merged;
}

async function syncDistrictFromFirebase(district = elDistrict.value) {
  if (typeof window.getDistrictRecordsFromFirebase !== 'function') return false;
  if (navigator.onLine === false) return false;

  try {
    const remoteDocs = await window.getDistrictRecordsFromFirebase(district);
    const remoteRecords = buildLocalRecordsFromRemoteDocs(remoteDocs);

    // 긴급 복구 모드:
    // 서버에 없는 과거 local 기록은 절대 지우지 않는다.
    // 같은 날짜/같은 모임에 서버 기록이 있으면 관리자 수정본을 우선 반영한다.
    // 그래서 admin 삭제 실수는 상대 index의 local 기록까지 즉시 삭제하지 않는다.
    allAttendanceRecords[district] = mergeFirstServerSyncRecords(
      allAttendanceRecords[district] || {},
      remoteRecords,
    );
    // 서버에 아직 도착하지 못한 로컬 저장/삭제가 있으면 서버의 오래된 값보다 우선한다.
    applyPendingAttendanceWrites(district);
    saveRecords();
    markServerSyncedDistrict(district);
    return true;
  } catch (err) {
    console.warn('server sync failed', err);
    return false;
  }
}

async function syncCurrentRecordToFirebase(date, type, record, stillExists, district = elDistrict.value) {
  const entry = stillExists
    ? {
        op: 'save',
        district,
        date,
        type,
        record: [...record],
        payload: buildFirebaseSubmissionPayload({ district, date, type, record }),
      }
    : { op: 'delete', district, date, type, record: [] };

  if (navigator.onLine === false) {
    setPendingAttendanceWrite(entry);
    return { serverSaved: false, queued: true };
  }

  try {
    if (!stillExists) {
      await withTimeout(deleteAttendance(district, date, type));
    } else {
      await withTimeout(submitAttendance(entry.payload));
    }
    clearPendingAttendanceWrite(district, date, type);
    return { serverSaved: true, queued: false };
  } catch (err) {
    console.warn('current record sync failed', err);
    setPendingAttendanceWrite(entry);
    return { serverSaved: false, queued: true, error: err };
  }
}

function findLocalMeetingMismatches() {
  const issues = [];
  Object.entries(allAttendanceRecords || {}).forEach(([district, records]) => {
    getValidRecordDates(records || {}).forEach((dateKey) => {
      const dayRecords = records[dateKey] || {};
      Object.keys(dayRecords).forEach((type) => {
        if (type !== '주일말씀' && type !== '수요말씀') return;
        const expected = getExpectedMeetingTypeByDate(dateKey);
        if (expected && expected !== type) issues.push({ district, dateKey, type, expected });
      });
    });
  });
  return issues;
}

function mergeAttendanceNameRecords(a = [], b = []) {
  const result = [];
  const seen = new Set();

  [...a, ...b].forEach((name) => {
    const clean = normalizeNameValue(name);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    result.push(clean);
  });

  return result;
}

function applyLocalMeetingAutoCorrections() {
  const corrections = [];

  Object.entries(allAttendanceRecords || {}).forEach(([district, records]) => {
    getValidRecordDates(records || {}).forEach((dateKey) => {
      const dayRecords = records[dateKey] || {};

      ['주일말씀', '수요말씀'].forEach((type) => {
        const record = dayRecords[type];
        if (!Array.isArray(record)) return;

        const expected = getExpectedMeetingTypeByDate(dateKey);
        if (!expected || expected === type) return;

        const existingTarget = Array.isArray(dayRecords[expected]) ? dayRecords[expected] : [];
        const mergedRecord = mergeAttendanceNameRecords(existingTarget, record);

        dayRecords[expected] = mergedRecord;
        delete dayRecords[type];

        corrections.push({
          district,
          dateKey,
          from: type,
          to: expected,
          record: mergedRecord,
        });
      });

      if (Object.keys(dayRecords).length === 0) delete records[dateKey];
    });
  });

  if (corrections.length > 0) saveRecords();
  return corrections;
}

async function syncLocalCorrectionsToFirebase(corrections = []) {
  if (!corrections.length) return;

  for (const item of corrections) {
    await syncCurrentRecordToFirebase(item.dateKey, item.to, item.record, true, item.district);
    await syncCurrentRecordToFirebase(item.dateKey, item.from, [], false, item.district);
  }
}

function syncLocalMeetingMismatchesOnOpen() {
  const corrections = applyLocalMeetingAutoCorrections();
  syncLocalCorrectionsToFirebase(corrections);
  return corrections;
}

function escapeHtml(value) {
  return escapeHtmlValue(value);
}

async function checkGlobalNotice() {
  if (typeof window.getGlobalNoticeFromFirebase !== 'function') return;
  try {
    const notice = await window.getGlobalNoticeFromFirebase();
    if (!notice || notice.active === false) return;
    const noticeId = notice.noticeId || notice.id || '';
    const message = String(notice.message || '').trim();
    if (!noticeId || !message) return;
    if (localStorage.getItem(STORAGE_KEY_GLOBAL_NOTICE) === noticeId) return;

    document.getElementById('global-notice-title').textContent = notice.title || '공지사항';
    document.getElementById('global-notice-message').innerHTML = escapeHtml(message).replace(/\n/g, '<br>');
    const modal = document.getElementById('global-notice-modal');
    const btn = document.getElementById('btn-global-notice-confirm');
    btn.onclick = () => {
      localStorage.setItem(STORAGE_KEY_GLOBAL_NOTICE, noticeId);
      modal.classList.remove('show');
    };
    setTimeout(() => modal.classList.add('show'), 500);
  } catch (err) {
    console.warn('global notice check failed', err);
  }
}

function initEventListeners() {
  elDistrict.addEventListener('change', async (e) => {
    if (!confirmIfDirty()) {
      e.target.value = localStorage.getItem(STORAGE_KEY_LASTDISTRICT) || '11구역';
      return;
    }

    localStorage.setItem(STORAGE_KEY_LASTDISTRICT, elDistrict.value);
    await syncRosterFromFirebase(elDistrict.value);
    await syncDistrictFromFirebase(elDistrict.value);
    syncLocalMeetingMismatchesOnOpen();
    loadWorkingRecord();
    renderAttendanceGrid();
    await loadMonthlyActivity();
    if (document.getElementById('prayer-section').classList.contains('show')) renderPrayerList();
  });

  elDate.addEventListener('change', async () => {
    if (!confirmIfDirty()) return;
    await syncDistrictFromFirebase(elDistrict.value);
    syncLocalMeetingMismatchesOnOpen();
    loadWorkingRecord();
    renderAttendanceGrid();
    await loadMonthlyActivity();
  });

  elType.addEventListener('change', handleMeetingTypeChange);

  document.getElementById('btn-home').addEventListener('click', showHomePage);

  document.querySelectorAll('.btn-setup').forEach((btn) => btn.addEventListener('click', openSetup));
  document.getElementById('btn-template-download').addEventListener('click', downloadMemberTemplate);
  document
    .getElementById('btn-member-upload')
    .addEventListener('click', () => triggerFilePicker('member-upload-input'));
  document.getElementById('member-upload-input').addEventListener('change', handleMemberFileUpload);
  document.getElementById('save-setup').addEventListener('click', saveSetup);
  elBtnSaveRecord.addEventListener('click', saveCurrentRecord);
  document.getElementById('btn-monthly-activity').addEventListener('click', openMonthlyActivityModal);
  document.getElementById('btn-add-evangelism').addEventListener('click', () => addMonthlyEvangelismRow());
  document.getElementById('btn-add-visit').addEventListener('click', () => addMonthlyVisitRow());
  document.getElementById('btn-save-monthly-activity').addEventListener('click', saveMonthlyActivity);

  elPrayerDistrict.addEventListener('change', (e) => selectPrayerDistrict(e.target.value));
  elPrayerImageDistrict.addEventListener('change', updatePrayerImageConfirmSummary);
  document.getElementById('btn-add-prayer').addEventListener('click', addPrayerMember);
  document.getElementById('btn-prayer-template').addEventListener('click', downloadPrayerTemplate);
  document
    .getElementById('btn-prayer-upload')
    .addEventListener('click', () => triggerFilePicker('prayer-upload-input'));
  document.getElementById('btn-export-prayer').addEventListener('click', exportPrayerList);
  document.getElementById('btn-export-prayer-image').addEventListener('click', openPrayerImageConfirm);
  document.getElementById('btn-confirm-prayer-image').addEventListener('click', confirmPrayerImageExport);
  document.getElementById('btn-download-prayer-images').addEventListener('click', downloadAllPrayerImages);
  document.getElementById('prayer-upload-input').addEventListener('change', handlePrayerFileUpload);

  document.querySelector('.btn-stats').addEventListener('click', openStats);
  document.getElementById('volunteer-section').addEventListener('click', handleVolunteerClick);
  elVolunteerDistrict.addEventListener('input', saveVolunteerDistrict);
  elVolunteerDistrict.addEventListener('blur', saveVolunteerDistrict);
  elVolunteerName.addEventListener('input', (e) => {
    volunteerState.form.name = e.target.value;
    updateVolunteerCount();
    saveVolunteerState();
  });
  elVolunteerPhone.addEventListener('input', (e) => {
    let value = e.target.value.replace(/[^0-9]/g, '').slice(0, 11);
    if (value.length >= 8) value = value.replace(/(\d{3})(\d{4})(\d{1,4})/, '$1-$2-$3');
    else if (value.length >= 4) value = value.replace(/(\d{3})(\d{1,4})/, '$1-$2');
    e.target.value = value;
    volunteerState.form.phone = value;
    saveVolunteerState();
  });
  document.getElementById('volunteer-add-person').addEventListener('click', addVolunteerPerson);
  document.getElementById('volunteer-preview-btn').addEventListener('click', openVolunteerPreview);
  document.getElementById('volunteer-preview-export').addEventListener('click', exportVolunteerWorkbook);
  document.getElementById('volunteer-export-btn').addEventListener('click', exportVolunteerWorkbook);
  document.getElementById('volunteer-reset-btn').addEventListener('click', resetVolunteerCurrentForm);

  document.querySelector('.btn-share').addEventListener('click', openShare);
  document.getElementById('btn-share-text').addEventListener('click', shareAsText);
  document.getElementById('btn-share-image').addEventListener('click', shareAsImage);
  document.getElementById('btn-download-image').addEventListener('click', downloadImage);

  document.querySelector('.btn-more').addEventListener('click', () => {
    document.getElementById('more-modal').classList.add('show');
    refreshIcons();
  });
  document.getElementById('more-home').addEventListener('click', showHomePage);
  document.getElementById('more-prayer').addEventListener('click', () => {
    document.getElementById('more-modal').classList.remove('show');
    openPrayerSection();
  });
  document.getElementById('more-volunteer').addEventListener('click', () => {
    document.getElementById('more-modal').classList.remove('show');
    openVolunteerSection();
  });
  document.getElementById('btn-update-confirm').addEventListener('click', confirmUpdateNotice);

  document.querySelectorAll('.stats-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      currentStatsType = tab.dataset.type;
      document.querySelectorAll('.stats-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderStats();
    });
  });

  document.getElementById('stats-month-select').addEventListener('change', (e) => {
    currentStatsMonth = e.target.value;
    renderStats();
  });

  document.querySelectorAll('.stats-main-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const main = tab.dataset.main;
      document.querySelectorAll('.stats-main-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('stats-monthly-wrap').style.display = main === 'monthly' ? 'block' : 'none';
      document.getElementById('stats-personal-wrap').style.display = main === 'personal' ? 'block' : 'none';
      if (main === 'personal') renderPersonalStats();
    });
  });

  document.querySelectorAll('.personal-cat-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      currentPersonalCat = tab.dataset.cat;
      document
        .querySelectorAll('.personal-cat-tab')
        .forEach((t) => t.classList.remove('active', 'eun', 'bong', 'mom', 'youth'));
      tab.classList.add('active', CATEGORIES[currentPersonalCat].btnClass);
      renderPersonalStats();
    });
  });

  document.querySelectorAll('.personal-type-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      currentPersonalType = tab.dataset.mtype;
      document.querySelectorAll('.personal-type-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderPersonalStats();
    });
  });

  document.getElementById('personal-month-select').addEventListener('change', (e) => {
    currentPersonalMonth = e.target.value;
    renderPersonalStats();
  });

  document.querySelectorAll('.close-modal').forEach((btn) => {
    btn.addEventListener('click', () =>
      document.querySelectorAll('.modal').forEach((m) => m.classList.remove('show')),
    );
  });

  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) e.target.classList.remove('show');
  });

  window.addEventListener('beforeunload', (e) => {
    if (isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('online', async () => {
    const result = await flushPendingAttendanceWrites();
    if (result.ok > 0) {
      await syncDistrictFromFirebase(elDistrict.value);
      loadWorkingRecord();
      renderAttendanceGrid();
    }
  });
}

async function init() {
  buildDistrictDropdown();
  elDate.value = localDateKey();
  previousMeetingType = elType.value;
  loadData();
  await flushPendingAttendanceWrites();
  await syncRosterFromFirebase(elDistrict.value);
  await syncDistrictFromFirebase(elDistrict.value);
  syncLocalMeetingMismatchesOnOpen();
  loadWorkingRecord();
  renderAttendanceGrid();
  await loadMonthlyActivity();
  initEventListeners();
  installAccessibleModals();
  refreshIcons();
  if (APP_VERSION === SILENT_UPDATE_VERSION) {
    localStorage.setItem(STORAGE_KEY_UPDATE_NOTICE, APP_VERSION);
  }
  showUpdateNotice();
  checkGlobalNotice();
}

init();
