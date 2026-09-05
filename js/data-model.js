export function normalizeName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function legacyMemberId(district, category, name) {
  return `legacy_${stableHash(`${district}|${category}|${normalizeName(name)}`)}`;
}

export function ensureMemberId(member, district = '', category = '') {
  const name = normalizeName(member?.name || member?.이름);
  const cat = member?.cat || member?.구분 || category || '은장회';
  return String(member?.id || member?.memberId || legacyMemberId(district, cat, name));
}

export function normalizeRosterMembers(members, district = '') {
  const seenIds = new Map();
  return (Array.isArray(members) ? members : [])
    .filter((member) => member && normalizeName(member.name))
    .map((member) => {
      const baseId = ensureMemberId(member, district, member.cat);
      const occurrence = (seenIds.get(baseId) || 0) + 1;
      seenIds.set(baseId, occurrence);
      return {
        ...member,
        // 과거 명단에 id가 없고 동명이인이 있으면 배열 순서를 기준으로
        // 한 번만 서로 다른 id를 부여한다. 이후 Firebase에 저장되어 유지된다.
        id: occurrence === 1 ? baseId : `${baseId}_${occurrence}`,
        name: normalizeName(member.name),
        active: member.active !== false,
      };
    });
}

export function memberToken(member, district = '', category = '') {
  return ensureMemberId(member, district, category) || normalizeName(member?.name);
}

export function recordHasPerson(record, member, district = '', category = '') {
  if (!Array.isArray(record) || !member) return false;
  const id = ensureMemberId(member, district, category);
  const name = normalizeName(member.name || member.이름);
  return (id && record.includes(id)) || (name && record.includes(name));
}

export function removePersonFromRecord(record, member, district = '', category = '') {
  if (!Array.isArray(record)) return [];
  const id = ensureMemberId(member, district, category);
  const name = normalizeName(member?.name || member?.이름);
  return record.filter((token) => token !== id && token !== name);
}

export function togglePersonInRecord(record, member, district = '', category = '') {
  const current = Array.isArray(record) ? [...record] : [];
  if (recordHasPerson(current, member, district, category)) {
    return removePersonFromRecord(current, member, district, category);
  }
  current.push(memberToken(member, district, category));
  return current;
}

export function categoryMembersFromSubmission(submission, category) {
  const data = submission?.출석데이터?.[category] || {};
  const allNames = Array.isArray(data.전체) ? data.전체.map(normalizeName) : [];
  const allIds = Array.isArray(data.전체ID) ? data.전체ID.map(String) : [];
  const presentNames = new Set(Array.isArray(data.출석) ? data.출석.map(normalizeName) : []);
  const presentIds = new Set(Array.isArray(data.출석ID) ? data.출석ID.map(String) : []);
  const length = Math.max(allNames.length, allIds.length);

  return Array.from({ length }, (_, index) => {
    const name = allNames[index] || `이름 미상 ${index + 1}`;
    const id = allIds[index] || '';
    const key = id ? `id:${id}` : `legacy:${submission?.구역 || ''}|${category}|${normalizeName(name)}`;
    return {
      id,
      key,
      name,
      present: id ? presentIds.has(id) : presentNames.has(name),
    };
  });
}
