export const FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyCb5ULk6CNFvc24WZXn_PNAurY5F3C3qO4',
  authDomain: 'bongsun-17d80.firebaseapp.com',
  projectId: 'bongsun-17d80',
  storageBucket: 'bongsun-17d80.firebasestorage.app',
  messagingSenderId: '122450922261',
  appId: '1:122450922261:web:f552a646f323e3a78b771c',
});

export const ALL_DISTRICTS = Object.freeze(
  [10, 20, 30, 40].flatMap((base) => Array.from({ length: 5 }, (_, index) => `${base + index + 1}구역`)),
);

export const MEETING_TYPES = Object.freeze(['주일말씀', '수요말씀', '구역모임']);

export const CATEGORIES = Object.freeze({
  EUN: {
    key: 'eun',
    name: '은장회',
    titleClass: 'title-eun',
    btnClass: 'eun',
    cardClass: 'cat-eun',
    rowClass: 'eun-row',
    icon: 'users-round',
  },
  BONG: {
    key: 'bong',
    name: '봉사회',
    titleClass: 'title-bong',
    btnClass: 'bong',
    cardClass: 'cat-bong',
    rowClass: 'bong-row',
    icon: 'hand-heart',
  },
  MOM: {
    key: 'mom',
    name: '어머니회',
    titleClass: 'title-mom',
    btnClass: 'mom',
    cardClass: 'cat-mom',
    rowClass: 'mom-row',
    icon: 'heart',
  },
  YOUTH: {
    key: 'youth',
    name: '청년회',
    titleClass: 'title-youth',
    btnClass: 'youth',
    cardClass: 'cat-youth',
    rowClass: 'youth-row',
    icon: 'sparkles',
  },
});

export const CAT_ORDER = Object.freeze(['EUN', 'BONG', 'MOM', 'YOUTH']);
export const CAT_NAMES = Object.freeze(CAT_ORDER.map((key) => CATEGORIES[key].name));

export const CAT_META = Object.freeze({
  은장회: { tdClass: 'td-eun', cardClass: 'cat-eun', icon: 'users-round' },
  봉사회: { tdClass: 'td-bong', cardClass: 'cat-bong', icon: 'hand-heart' },
  어머니회: { tdClass: 'td-mom', cardClass: 'cat-mom', icon: 'heart' },
  청년회: { tdClass: 'td-youth', cardClass: 'cat-youth', icon: 'sparkles' },
});
