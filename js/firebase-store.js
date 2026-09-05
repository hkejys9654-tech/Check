import { ALL_DISTRICTS, FIREBASE_CONFIG } from './config.js';
import { monthBounds } from './date-utils.js';

const FIREBASE_VERSION = '11.7.1';
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

let firebaseApi = null;
let firebaseLoadPromise = null;
export let db = null;

function withNetworkTimeout(promise, timeoutMs = 12000) {
  let timerId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timerId = globalThis.setTimeout(
        () => reject(new Error('Firebase 응답 시간이 초과되었습니다.')),
        timeoutMs,
      );
    }),
  ]).finally(() => globalThis.clearTimeout(timerId));
}

async function ensureFirebase() {
  if (firebaseApi && db) return firebaseApi;
  if (firebaseLoadPromise) return firebaseLoadPromise;

  firebaseLoadPromise = withNetworkTimeout(
    Promise.all([
      import(`${FIREBASE_BASE}/firebase-app.js`),
      import(`${FIREBASE_BASE}/firebase-firestore.js`),
    ]),
  )
    .then(([appApi, firestoreApi]) => {
      const app = appApi.initializeApp(FIREBASE_CONFIG);
      db = firestoreApi.getFirestore(app);
      firebaseApi = firestoreApi;
      return firestoreApi;
    })
    .catch((error) => {
      firebaseLoadPromise = null;
      throw error;
    });

  return firebaseLoadPromise;
}

function requireFirebase() {
  if (!firebaseApi || !db)
    throw new Error('Firebase 연결을 불러오지 못했습니다. 인터넷 연결을 확인해주세요.');
  return firebaseApi;
}

export const collection = (...args) => requireFirebase().collection(...args);
export const deleteDoc = (...args) => withNetworkTimeout(requireFirebase().deleteDoc(...args));
export const doc = (...args) => requireFirebase().doc(...args);
export const getDoc = (...args) => withNetworkTimeout(requireFirebase().getDoc(...args));
export const getDocs = (...args) => withNetworkTimeout(requireFirebase().getDocs(...args));
export const serverTimestamp = (...args) => requireFirebase().serverTimestamp(...args);
export const setDoc = (...args) => withNetworkTimeout(requireFirebase().setDoc(...args));
export const updateDoc = (...args) => withNetworkTimeout(requireFirebase().updateDoc(...args));
export const writeBatch = (...args) => requireFirebase().writeBatch(...args);

export async function submitAttendance(submission) {
  const api = await ensureFirebase();
  const docId = `${submission.날짜}_${submission.모임}`;
  await withNetworkTimeout(
    api.setDoc(
      api.doc(db, 'submissions', submission.구역, 'records', docId),
      { ...submission, 제출시간: api.serverTimestamp() },
      { merge: true },
    ),
  );
}

export async function deleteAttendance(district, date, type) {
  const api = await ensureFirebase();
  await withNetworkTimeout(api.deleteDoc(api.doc(db, 'submissions', district, 'records', `${date}_${type}`)));
}

export async function getGlobalNotice() {
  const api = await ensureFirebase();
  const snapshot = await withNetworkTimeout(api.getDoc(api.doc(db, 'notices', 'global')));
  return snapshot.exists() ? snapshot.data() : null;
}

export async function getDistrictRecords(district) {
  const api = await ensureFirebase();
  const snapshot = await withNetworkTimeout(
    api.getDocs(api.collection(db, 'submissions', district, 'records')),
  );
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function getRoster(district) {
  const api = await ensureFirebase();
  const snapshot = await withNetworkTimeout(api.getDoc(api.doc(db, 'rosters', district)));
  return snapshot.exists()
    ? { exists: true, ...snapshot.data() }
    : { exists: false, members: [], updatedAtMs: 0 };
}

export async function saveRoster(district, members) {
  const api = await ensureFirebase();
  const updatedAtMs = Date.now();
  await withNetworkTimeout(
    api.setDoc(
      api.doc(db, 'rosters', district),
      { members, updatedAtMs, updatedAt: api.serverTimestamp() },
      { merge: true },
    ),
  );
  return updatedAtMs;
}

export async function getMonthlyActivity(district, monthKey) {
  const api = await ensureFirebase();
  const snapshot = await withNetworkTimeout(
    api.getDoc(api.doc(db, 'monthlyActivities', district, 'months', monthKey)),
  );
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

export async function saveMonthlyActivity(district, monthKey, data) {
  const api = await ensureFirebase();
  await withNetworkTimeout(
    api.setDoc(
      api.doc(db, 'monthlyActivities', district, 'months', monthKey),
      { ...data, 구역: district, 월: monthKey, 수정시간: api.serverTimestamp() },
      { merge: true },
    ),
  );
}

export async function fetchAdminSubmissions(scope = 'all') {
  const api = await ensureFirebase();
  const bounds = scope === 'all' ? null : monthBounds(scope);
  if (!bounds) {
    const snapshot = await withNetworkTimeout(api.getDocs(api.collectionGroup(db, 'records')));
    return snapshot.docs.map((item) => ({
      id: item.id,
      _pathDistrict: item.ref.parent.parent?.id || '',
      ...item.data(),
    }));
  }

  // 날짜 필드의 컬렉션 그룹 인덱스가 없어도 동작하도록 문서 경로 범위를 사용합니다.
  // 한 달의 20개 구역 범위는 Firestore의 OR 한도(30) 안에 들어갑니다.
  try {
    const districtRanges = ALL_DISTRICTS.map((district) =>
      api.and(
        api.where(api.documentId(), '>=', api.doc(db, 'submissions', district, 'records', bounds.start)),
        api.where(api.documentId(), '<', api.doc(db, 'submissions', district, 'records', bounds.end)),
      ),
    );
    const source = api.query(api.collectionGroup(db, 'records'), api.or(...districtRanges));
    const snapshot = await withNetworkTimeout(api.getDocs(source));
    return snapshot.docs.map((item) => ({
      id: item.id,
      _pathDistrict: item.ref.parent.parent?.id || '',
      ...item.data(),
    }));
  } catch (primaryError) {
    // 오래된 SDK/규칙 환경에서는 구역별 월 쿼리로 폴백하되, 일부 실패가
    // 다른 구역의 결과까지 버리지 않게 합니다.
    const settled = await Promise.allSettled(
      ALL_DISTRICTS.map(async (district) => {
        const source = api.query(
          api.collection(db, 'submissions', district, 'records'),
          api.where('날짜', '>=', bounds.start),
          api.where('날짜', '<', bounds.end),
        );
        const snapshot = await withNetworkTimeout(api.getDocs(source));
        return snapshot.docs.map((item) => ({ id: item.id, _pathDistrict: district, ...item.data() }));
      }),
    );
    const rows = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    const failedCount = settled.filter((result) => result.status === 'rejected').length;
    if (failedCount) {
      Object.defineProperty(rows, 'loadWarnings', {
        value: [`${failedCount}개 구역 조회 실패`],
        enumerable: false,
      });
    }
    if (failedCount === ALL_DISTRICTS.length) throw primaryError;
    return rows;
  }
}

export async function fetchAdminMonthlyActivities(scope = 'all') {
  const api = await ensureFirebase();
  let source = api.collectionGroup(db, 'months');
  if (scope !== 'all') {
    const monthRefs = ALL_DISTRICTS.map((district) =>
      api.doc(db, 'monthlyActivities', district, 'months', scope),
    );
    source = api.query(source, api.where(api.documentId(), 'in', monthRefs));
  }
  const snapshot = await withNetworkTimeout(api.getDocs(source));
  return snapshot.docs.map((item) => ({
    id: item.id,
    구역: item.ref.parent.parent?.id || item.data().구역 || '',
    월: item.id,
    ...item.data(),
  }));
}

export async function fetchAdminRosters() {
  const api = await ensureFirebase();
  const snapshot = await withNetworkTimeout(api.getDocs(api.collection(db, 'rosters')));
  return snapshot.docs.map((item) => ({
    district: item.id,
    exists: true,
    members: Array.isArray(item.data().members) ? item.data().members : [],
    updatedAtMs: Number(item.data().updatedAtMs) || 0,
  }));
}

export async function fetchStatsSettings() {
  const api = await ensureFirebase();
  return withNetworkTimeout(api.getDoc(api.doc(db, 'settings', 'stats')));
}

export async function fetchLatestSubmission(district) {
  const api = await ensureFirebase();
  const source = api.query(
    api.collection(db, 'submissions', district, 'records'),
    api.orderBy('날짜', 'desc'),
    api.limit(1),
  );
  const snapshot = await withNetworkTimeout(api.getDocs(source));
  const item = snapshot.docs[0];
  return item ? { id: item.id, _pathDistrict: district, ...item.data() } : null;
}
