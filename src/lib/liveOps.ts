import { getTodayKey, getWeekKey } from "./leaderboard";
import {
  MAX_HEARTS,
  persistPlayerProfile,
  type CharacterId,
  type CosmeticId,
  type PlayerProfile,
} from "./player";
import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";

const LOCAL_CHECKIN_PREFIX = "ani-pang-checkin";
const LOCAL_MISSION_PREFIX = "ani-pang-daily-mission";
const LOCAL_WEEKLY_MISSION_PREFIX = "ani-pang-weekly-mission";
const LOCAL_STAGE_PREFIX = "ani-pang-stage-progress";
const LOCAL_PASS_PREFIX = "ani-pang-season-pass";
const PASS_XP_PER_LEVEL = 500;

let firebaseUnavailable = false;
let liveOpsConfigPromise: Promise<LiveOpsConfig | null> | null = null;

export interface SeasonCurrent {
  id: string;
  title: string;
  theme: string;
  startsAt: string;
  endsAt: string;
}

export type ShopCategory = "hearts" | "boosters" | "skins" | "pack";

export interface ShopItem {
  id: string;
  category: ShopCategory;
  name: string;
  desc: string;
  price: number;
  currency: "stars" | "coins" | "iap";
  tag?: string;
  productId?: string;
}

export interface LiveOpsConfig {
  season: SeasonCurrent;
  shopItems: ShopItem[];
  eventBanners: unknown[];
  experiments: Record<string, string>;
  fetchedAt: string;
}

export interface DailyCheckinStatus {
  currentDay: number;
  claimed: number[];
  claimedToday: boolean;
  resetAt: string;
  rewards: { day: number; stars: number; label: string }[];
}

export type DailyMissionMetric = "score" | "maxCombo" | "specialTriggers" | "feverCount";
export type MissionAggregate = "max" | "sum";

export interface DailyMission {
  id: string;
  label: string;
  title: string;
  metric: DailyMissionMetric;
  goal: number;
  rewardStars: number;
}

export interface DailyMissionStatus {
  dayKey: string;
  mission: DailyMission;
  progress: number;
  claimed: boolean;
  completed: boolean;
  rewards: { stars: number };
  resetAt: string;
}

export interface WeeklyMission extends DailyMission {
  aggregate: MissionAggregate;
}

export interface WeeklyMissionItemStatus {
  mission: WeeklyMission;
  progress: number;
  claimed: boolean;
  completed: boolean;
  rewards: { stars: number };
}

export interface WeeklyMissionStatus {
  weekKey: string;
  missions: WeeklyMissionItemStatus[];
  resetAt: string;
}

export interface DailyMissionClaimResult {
  profile: PlayerProfile;
  status: DailyMissionStatus;
  granted: boolean;
  rewards: { stars: number };
  message: string;
}

export interface WeeklyMissionClaimResult {
  profile: PlayerProfile;
  status: WeeklyMissionStatus;
  granted: boolean;
  rewards: { stars: number };
  message: string;
}

export interface StageProgress {
  chapter: string;
  currentStage: number;
  stars: Record<string, number>;
}

export type SeasonPassTrack = "free" | "premium";

export interface SeasonPassReward {
  label: string;
  stars?: number;
  coins?: number;
  hearts?: number;
  inventory?: Partial<PlayerProfile["inventory"]>;
  character?: CharacterId;
  cosmetic?: CosmeticId;
}

export interface SeasonPassTier {
  level: number;
  free: SeasonPassReward;
  premium: SeasonPassReward;
  unlocked: boolean;
  claimed: Record<SeasonPassTrack, boolean>;
}

export interface SeasonPassStatus {
  season: SeasonCurrent;
  endsAt: string;
  currentLevel: number;
  xp: number;
  xpToNext: number;
  premium: boolean;
  tiers: SeasonPassTier[];
}

export interface SeasonPassClaimResult {
  profile: PlayerProfile;
  status: SeasonPassStatus;
  granted: boolean;
  rewards: SeasonPassReward;
  message: string;
}

export interface CharacterDexEntry {
  animal: CharacterId;
  name: string;
  role: string;
  rarity: "COMMON" | "RARE" | "EPIC";
  skill: string;
  skillId: string;
  unlocked: boolean;
  level: number;
  affinity: number;
  plays: number;
}

export interface ShopPurchaseResult {
  profile: PlayerProfile;
  purchased: boolean;
  message: string;
}

export interface IapVerifyInput {
  platform: "ios" | "android";
  productId: string;
  transactionId?: string;
  purchaseToken?: string;
}

export interface IapVerifyResult {
  profile: PlayerProfile;
  granted: boolean;
  alreadyGranted: boolean;
  item: ShopItem;
  rewards: {
    hearts: number;
    stars: number;
    coins: number;
    inventory: Partial<PlayerProfile["inventory"]>;
    seasonPassPremium: boolean;
    vipDays: number;
  };
}

const fallbackSeason: SeasonCurrent = {
  id: "color-rush-s2",
  title: "시즌 2 · 컬러 러시",
  theme: "COLOR_RUSH",
  startsAt: "2026-05-01T00:00:00+09:00",
  endsAt: "2026-06-01T00:00:00+09:00",
};

const fallbackShopItems: ShopItem[] = [
  {
    id: "heart-1",
    category: "hearts",
    name: "하트 1",
    desc: "즉시 1개",
    price: 50,
    currency: "stars",
  },
  {
    id: "heart-5",
    category: "hearts",
    name: "하트 5",
    desc: "한 세트",
    price: 200,
    currency: "stars",
    tag: "인기",
  },
  {
    id: "hint-5",
    category: "boosters",
    name: "힌트 x5",
    desc: "막힐 때 한 수",
    price: 180,
    currency: "stars",
  },
  {
    id: "shuffle-3",
    category: "boosters",
    name: "셔플 x3",
    desc: "보드 다시 섞기",
    price: 240,
    currency: "stars",
  },
  {
    id: "starter-pack",
    category: "pack",
    name: "신입 패키지",
    desc: "하트+부스터+스킨",
    price: 990,
    currency: "iap",
    tag: "70%",
    productId: "starter_pack",
  },
  {
    id: "season-pass",
    category: "pack",
    name: "시즌 패스",
    desc: "시즌 한정 보상",
    price: 9900,
    currency: "iap",
    tag: "HOT",
    productId: "season_pass_s2",
  },
  {
    id: "vip-monthly",
    category: "pack",
    name: "VIP 월정액",
    desc: "30일 VIP 혜택",
    price: 4900,
    currency: "iap",
    tag: "VIP",
    productId: "vip_monthly",
  },
];

const checkinRewards = [
  { day: 1, stars: 20, label: "별 20" },
  { day: 2, stars: 30, label: "별 30" },
  { day: 3, stars: 40, label: "별 40" },
  { day: 4, stars: 60, label: "별 60" },
  { day: 5, stars: 80, label: "별 80" },
  { day: 6, stars: 100, label: "별 100" },
  { day: 7, stars: 150, label: "별 150" },
];

const dailyMissions: DailyMission[] = [
  {
    id: "score-12000",
    label: "TODAY",
    title: "12,000점 넘기기",
    metric: "score",
    goal: 12000,
    rewardStars: 40,
  },
  {
    id: "combo-6",
    label: "TODAY",
    title: "6콤보 한 번 달성",
    metric: "maxCombo",
    goal: 6,
    rewardStars: 35,
  },
  {
    id: "special-3",
    label: "TODAY",
    title: "특수 효과 3회 발동",
    metric: "specialTriggers",
    goal: 3,
    rewardStars: 35,
  },
  {
    id: "fever-1",
    label: "TODAY",
    title: "피버 1회 켜기",
    metric: "feverCount",
    goal: 1,
    rewardStars: 30,
  },
];

const weeklyMissions: WeeklyMission[] = [
  {
    id: "weekly-score-50000",
    label: "WEEKLY",
    title: "주간 누적 50,000점",
    metric: "score",
    goal: 50000,
    rewardStars: 120,
    aggregate: "sum",
  },
  {
    id: "weekly-special-25",
    label: "WEEKLY",
    title: "특수 효과 25회",
    metric: "specialTriggers",
    goal: 25,
    rewardStars: 90,
    aggregate: "sum",
  },
  {
    id: "weekly-combo-10",
    label: "WEEKLY",
    title: "10콤보 달성",
    metric: "maxCombo",
    goal: 10,
    rewardStars: 80,
    aggregate: "max",
  },
];

const passTiers: Array<Omit<SeasonPassTier, "unlocked" | "claimed">> = [
  {
    level: 1,
    free: { label: "별 10", stars: 10 },
    premium: { label: "코인 50", coins: 50 },
  },
  {
    level: 2,
    free: { label: "힌트 x1", inventory: { hint: 1 } },
    premium: { label: "하트 3", hearts: 3 },
  },
  {
    level: 3,
    free: { label: "별 20", stars: 20 },
    premium: { label: "코인 120", coins: 120 },
  },
  {
    level: 4,
    free: { label: "해머 x1", inventory: { hammer: 1 } },
    premium: { label: "봄코트", cosmetic: "spring-coat" },
  },
  {
    level: 5,
    free: { label: "별 30", stars: 30 },
    premium: { label: "코인 200", coins: 200 },
  },
  {
    level: 6,
    free: { label: "하트 1", hearts: 1 },
    premium: { label: "판다미", character: "panda" },
  },
  {
    level: 7,
    free: { label: "별 50", stars: 50 },
    premium: { label: "코인 400", coins: 400 },
  },
  {
    level: 8,
    free: { label: "셔플 x1", inventory: { shuffle: 1 } },
    premium: { label: "황금 보드", cosmetic: "gold-board" },
  },
];

const characterDex = [
  {
    animal: "puppy",
    name: "몽이",
    role: "시간 보너스",
    rarity: "COMMON",
    skill: "가끔 +3초 행운 시간이 발동해요.",
    skillId: "puppy.lucky_time_3s",
  },
  {
    animal: "cat",
    name: "나비",
    role: "콤보 스타터",
    rarity: "COMMON",
    skill: "시작 콤보가 1 올라가요.",
    skillId: "cat.combo_start_plus_1",
  },
  {
    animal: "rabbit",
    name: "토리",
    role: "랜덤팡",
    rarity: "RARE",
    skill: "랜덤팡 생성 확률이 올라가요.",
    skillId: "rabbit.rainbow_plus_1",
  },
  {
    animal: "bear",
    name: "브라운",
    role: "폭발 범위",
    rarity: "RARE",
    skill: "팡이 폭발 범위가 넓어져요.",
    skillId: "bear.bomb_radius_plus_1",
  },
  {
    animal: "panda",
    name: "판다",
    role: "피버 지속",
    rarity: "EPIC",
    skill: "피버 시간이 2초 늘어나요.",
    skillId: "panda.fever_duration_plus_2s",
  },
  {
    animal: "chick",
    name: "삐약이",
    role: "피버 충전",
    rarity: "EPIC",
    skill: "피버 충전량이 1.5배가 돼요.",
    skillId: "chick.fever_charge_1_5x",
  },
] satisfies Omit<CharacterDexEntry, "unlocked" | "level" | "affinity" | "plays">[];

async function getFirebaseLiveOpsApi(requireAuth = false) {
  if (!isFirebaseConfigured || firebaseUnavailable) return null;
  const [firestore, firebase] = await Promise.all([
    import("firebase/firestore"),
    import("./firebase"),
  ]);
  if (!firebase.db) return null;
  if (requireAuth && !firebase.auth?.currentUser) return null;
  return { ...firestore, auth: firebase.auth, db: firebase.db };
}

async function callLiveOpsFunction<Input, Output>(name: string, data: Input) {
  if (!isFirebaseConfigured || !useFirebaseFunctions) return null;
  const [functionsApi, firebase] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  if (!firebase.firebaseApp || !firebase.auth?.currentUser) return null;
  const fn = functionsApi.httpsCallable<Input, Output>(
    functionsApi.getFunctions(firebase.firebaseApp),
    name,
  );
  const result = await fn(data);
  return result.data;
}

async function getLiveOpsConfigCached() {
  if (!liveOpsConfigPromise) {
    liveOpsConfigPromise = callLiveOpsFunction<Record<string, never>, LiveOpsConfig>(
      "getLiveOpsConfig",
      {},
    ).catch(() => null);
  }
  return liveOpsConfigPromise;
}

function localKey(prefix: string, uid: string) {
  return `${prefix}:${uid}`;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function tomorrowKstIso(today = getTodayKey()) {
  const date = new Date(`${today}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function nextWeekKstIso() {
  const localDate = new Date(`${getTodayKey()}T00:00:00+09:00`);
  const day = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() + (8 - day));
  return localDate.toISOString();
}

function previousDayKey(dayKey: string) {
  const date = new Date(`${dayKey}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() - 1);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeCheckin(
  raw: Partial<DailyCheckinStatus> & {
    lastClaimedKey?: string;
    cycleDay?: number;
  } = {},
): DailyCheckinStatus & { lastClaimedKey: string; cycleDay: number } {
  const today = getTodayKey();
  const lastClaimedKey = typeof raw.lastClaimedKey === "string" ? raw.lastClaimedKey : "";
  const claimedToday = lastClaimedKey === today;
  const previous = previousDayKey(today);
  const baseDay = lastClaimedKey === previous || claimedToday ? Number(raw.cycleDay) || 1 : 0;
  const currentDay = claimedToday ? Math.min(7, baseDay) : Math.min(7, baseDay + 1 || 1);
  const claimed = Array.isArray(raw.claimed)
    ? raw.claimed.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    : [];
  return {
    currentDay,
    claimed,
    claimedToday,
    resetAt: tomorrowKstIso(today),
    rewards: checkinRewards,
    lastClaimedKey,
    cycleDay: currentDay,
  };
}

function pickDailyMission(today = getTodayKey()) {
  const seed = [...today].reduce(
    (total, char, index) => total + char.charCodeAt(0) * (index + 3),
    0,
  );
  return dailyMissions[seed % dailyMissions.length];
}

function normalizeDailyMissionStatus(
  raw: Partial<DailyMissionStatus> & {
    missionId?: string;
    claimed?: boolean;
    dayKey?: string;
  } = {},
): DailyMissionStatus {
  const today = getTodayKey();
  const todayMission = pickDailyMission(today);
  const rawMission =
    dailyMissions.find((item) => item.id === raw.mission?.id || item.id === raw.missionId) ||
    todayMission;
  const sameDay = raw.dayKey === today && rawMission.id === todayMission.id;
  const mission = sameDay ? rawMission : todayMission;
  const progress = sameDay ? Math.max(0, Math.round(Number(raw.progress) || 0)) : 0;
  const claimed = sameDay && raw.claimed === true;
  return {
    dayKey: today,
    mission,
    progress: Math.min(mission.goal, progress),
    claimed,
    completed: claimed || progress >= mission.goal,
    rewards: { stars: mission.rewardStars },
    resetAt: tomorrowKstIso(today),
  };
}

function normalizeWeeklyMissionStatus(
  raw: {
    weekKey?: string;
    missions?: Array<Partial<WeeklyMissionItemStatus> & { missionId?: string }>;
  } = {},
): WeeklyMissionStatus {
  const currentWeek = getWeekKey();
  const sameWeek = raw.weekKey === currentWeek;
  const rawMissions = Array.isArray(raw.missions) && sameWeek ? raw.missions : [];
  return {
    weekKey: currentWeek,
    missions: weeklyMissions.map((mission) => {
      const rawItem = rawMissions.find(
        (item) => item.mission?.id === mission.id || item.missionId === mission.id,
      );
      const progress = Math.max(0, Math.round(Number(rawItem?.progress) || 0));
      const claimed = rawItem?.claimed === true;
      return {
        mission,
        progress: Math.min(mission.goal, progress),
        claimed,
        completed: claimed || progress >= mission.goal,
        rewards: { stars: mission.rewardStars },
      };
    }),
    resetAt: nextWeekKstIso(),
  };
}

function normalizeStageProgress(raw: Partial<StageProgress> | null = null): StageProgress {
  const stars = Object.fromEntries(
    Object.entries(raw?.stars || {}).map(([stageId, value]) => [
      stageId,
      Math.min(3, Math.max(0, Math.round(Number(value) || 0))),
    ]),
  );
  return {
    chapter: typeof raw?.chapter === "string" ? raw.chapter : "ch1",
    currentStage: Math.max(1, Math.round(Number(raw?.currentStage) || 1)),
    stars,
  };
}

function passLevelFromXp(xp: number) {
  return Math.min(passTiers.length, Math.floor(Math.max(0, xp) / PASS_XP_PER_LEVEL) + 1);
}

function normalizePassClaimed(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((level): level is number => Number.isInteger(level))
    .filter((level, index, list) => {
      return level >= 1 && level <= passTiers.length && list.indexOf(level) === index;
    })
    .sort((a, b) => a - b);
}

function normalizePassClaims(
  raw: Partial<Record<SeasonPassTrack | "seasonId", unknown>> | null,
  seasonId: string,
): Record<SeasonPassTrack, number[]> {
  if (!raw || raw.seasonId !== seasonId) return { free: [], premium: [] };
  return {
    free: normalizePassClaimed(raw.free),
    premium: normalizePassClaimed(raw.premium),
  };
}

function buildSeasonPassStatus(
  profile: PlayerProfile,
  claims: Record<SeasonPassTrack, number[]>,
  season: SeasonCurrent,
): SeasonPassStatus {
  const currentLevel = passLevelFromXp(profile.xp);
  const xp = currentLevel >= passTiers.length ? PASS_XP_PER_LEVEL : profile.xp % PASS_XP_PER_LEVEL;
  return {
    season,
    endsAt: season.endsAt,
    currentLevel,
    xp,
    xpToNext: PASS_XP_PER_LEVEL,
    premium: profile.seasonPassPremium,
    tiers: passTiers.map((tier) => ({
      ...tier,
      unlocked: tier.level <= currentLevel,
      claimed: {
        free: claims.free.includes(tier.level),
        premium: claims.premium.includes(tier.level),
      },
    })),
  };
}

function applyPassReward(profile: PlayerProfile, reward: SeasonPassReward): PlayerProfile {
  const inventory = { ...profile.inventory };
  for (const [key, value] of Object.entries(reward.inventory || {})) {
    const inventoryKey = key as keyof PlayerProfile["inventory"];
    inventory[inventoryKey] = Math.min(
      999,
      (inventory[inventoryKey] || 0) + Math.max(0, Math.round(Number(value) || 0)),
    );
  }

  return {
    ...profile,
    hearts: Math.min(MAX_HEARTS, profile.hearts + Math.max(0, Math.round(reward.hearts || 0))),
    stars: profile.stars + Math.max(0, Math.round(reward.stars || 0)),
    coins: Math.min(9999999, profile.coins + Math.max(0, Math.round(reward.coins || 0))),
    inventory,
    unlockedCharacters:
      reward.character && !profile.unlockedCharacters.includes(reward.character)
        ? [...profile.unlockedCharacters, reward.character]
        : profile.unlockedCharacters,
    characterLevels:
      reward.character && !profile.characterLevels[reward.character]
        ? { ...profile.characterLevels, [reward.character]: 1 }
        : profile.characterLevels,
    cosmetics:
      reward.cosmetic && !profile.cosmetics.includes(reward.cosmetic)
        ? [...profile.cosmetics, reward.cosmetic]
        : profile.cosmetics,
  };
}

export async function getSeasonCurrent(): Promise<SeasonCurrent> {
  try {
    const config = await getLiveOpsConfigCached();
    if (config?.season) return { ...fallbackSeason, ...config.season };
    const api = await getFirebaseLiveOpsApi();
    if (!api) return fallbackSeason;
    const { db, doc, getDoc } = api;
    const snapshot = await getDoc(doc(db, "liveConfig", "seasonCurrent"));
    return snapshot.exists() ? { ...fallbackSeason, ...snapshot.data() } : fallbackSeason;
  } catch {
    firebaseUnavailable = true;
    return fallbackSeason;
  }
}

export async function getShopItems(): Promise<ShopItem[]> {
  try {
    const config = await getLiveOpsConfigCached();
    if (Array.isArray(config?.shopItems) && config.shopItems.length) return config.shopItems;
    const api = await getFirebaseLiveOpsApi();
    if (!api) return fallbackShopItems;
    const { db, doc, getDoc } = api;
    const snapshot = await getDoc(doc(db, "liveConfig", "shopItems"));
    const items = snapshot.exists() ? snapshot.data().items : null;
    return Array.isArray(items) ? (items as ShopItem[]) : fallbackShopItems;
  } catch {
    firebaseUnavailable = true;
    return fallbackShopItems;
  }
}

export async function getDailyCheckinStatus(profile: PlayerProfile): Promise<DailyCheckinStatus> {
  const fallback = normalizeCheckin(
    parseJson(localStorage.getItem(localKey(LOCAL_CHECKIN_PREFIX, profile.uid)), {}),
  );
  try {
    if (profile.authMode !== "firebase") return fallback;
    const result = await callLiveOpsFunction<Record<string, never>, DailyCheckinStatus>(
      "getDailyCheckinStatus",
      {},
    );
    if (result) return normalizeCheckin(result);
    const api = await getFirebaseLiveOpsApi(true);
    if (!api) return fallback;
    const { db, doc, getDoc } = api;
    const snapshot = await getDoc(doc(db, "dailyCheckins", profile.uid));
    return normalizeCheckin(snapshot.exists() ? snapshot.data() : {});
  } catch {
    firebaseUnavailable = true;
    return fallback;
  }
}

export async function claimDailyCheckin(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    const result = await callLiveOpsFunction<
      Record<string, never>,
      {
        profile: PlayerProfile;
        status: { currentDay: number; claimed: number[]; claimedToday: boolean };
        rewards: { stars: number };
      }
    >("claimDailyCheckin", {});
    if (result) {
      return {
        profile: result.profile,
        status: normalizeCheckin({
          claimed: result.status.claimed,
          lastClaimedKey: result.status.claimedToday ? getTodayKey() : "",
          cycleDay: result.status.currentDay,
        }),
        rewards: result.rewards,
      };
    }
  }

  const today = getTodayKey();
  const status = normalizeCheckin(await getDailyCheckinStatus(profile));
  if (status.claimedToday) return { status, profile, rewards: { stars: 0 } };

  const reward = checkinRewards[status.currentDay - 1] || checkinRewards[0];
  const nextStatus = normalizeCheckin({
    claimed: [...new Set([...status.claimed, status.currentDay])],
    lastClaimedKey: today,
    cycleDay: status.currentDay,
  });
  const nextProfile = { ...profile, stars: profile.stars + reward.stars };

  localStorage.setItem(localKey(LOCAL_CHECKIN_PREFIX, profile.uid), JSON.stringify(nextStatus));
  await persistPlayerProfile(nextProfile);

  return { status: nextStatus, profile: nextProfile, rewards: { stars: reward.stars } };
}

export async function getDailyMissionStatus(profile: PlayerProfile): Promise<DailyMissionStatus> {
  const localStatus = normalizeDailyMissionStatus(
    parseJson(localStorage.getItem(localKey(LOCAL_MISSION_PREFIX, profile.uid)), {}),
  );
  const fallback = profile.completedDailyKeys.includes(localStatus.dayKey)
    ? {
        ...localStatus,
        progress: localStatus.mission.goal,
        claimed: true,
        completed: true,
      }
    : localStatus;
  try {
    if (profile.authMode !== "firebase") return fallback;
    const result = await callLiveOpsFunction<Record<string, never>, DailyMissionStatus>(
      "getDailyMissionStatus",
      {},
    );
    return result ? normalizeDailyMissionStatus(result) : fallback;
  } catch {
    firebaseUnavailable = true;
    return fallback;
  }
}

export async function claimDailyMission(profile: PlayerProfile): Promise<DailyMissionClaimResult> {
  if (profile.authMode === "firebase") {
    const result = await callLiveOpsFunction<Record<string, never>, DailyMissionClaimResult>(
      "claimDailyMission",
      {},
    );
    if (result) return result;
  }

  const status = await getDailyMissionStatus(profile);
  if (status.claimed) {
    return {
      profile,
      status,
      granted: false,
      rewards: { stars: 0 },
      message: "오늘의 도전 보상은 이미 받았어요.",
    };
  }
  if (!status.completed) {
    return {
      profile,
      status,
      granted: false,
      rewards: { stars: 0 },
      message: "아직 오늘의 도전을 완료하지 못했어요.",
    };
  }

  const nextProfile = {
    ...profile,
    stars: profile.stars + status.rewards.stars,
    completedDailyKeys: [...new Set([...profile.completedDailyKeys, status.dayKey])]
      .sort()
      .slice(-31),
    lastDailyKey: status.dayKey,
  };
  const nextStatus = { ...status, claimed: true, completed: true };
  localStorage.setItem(
    localKey(LOCAL_MISSION_PREFIX, profile.uid),
    JSON.stringify({
      dayKey: nextStatus.dayKey,
      missionId: nextStatus.mission.id,
      progress: nextStatus.mission.goal,
      claimed: true,
    }),
  );
  await persistPlayerProfile(nextProfile);
  return {
    profile: nextProfile,
    status: nextStatus,
    granted: true,
    rewards: { stars: status.rewards.stars },
    message: `오늘의 도전 +${status.rewards.stars}별`,
  };
}

export async function getWeeklyMissionStatus(profile: PlayerProfile): Promise<WeeklyMissionStatus> {
  const fallback = normalizeWeeklyMissionStatus(
    parseJson(localStorage.getItem(localKey(LOCAL_WEEKLY_MISSION_PREFIX, profile.uid)), {}),
  );
  try {
    if (profile.authMode !== "firebase") return fallback;
    const result = await callLiveOpsFunction<Record<string, never>, WeeklyMissionStatus>(
      "getWeeklyMissionStatus",
      {},
    );
    return result ? normalizeWeeklyMissionStatus(result) : fallback;
  } catch {
    firebaseUnavailable = true;
    return fallback;
  }
}

export async function claimWeeklyMission(
  profile: PlayerProfile,
  missionId: string,
): Promise<WeeklyMissionClaimResult> {
  if (profile.authMode === "firebase") {
    const result = await callLiveOpsFunction<{ missionId: string }, WeeklyMissionClaimResult>(
      "claimWeeklyMission",
      { missionId },
    );
    if (result) return result;
  }

  const status = await getWeeklyMissionStatus(profile);
  const missionStatus = status.missions.find((item) => item.mission.id === missionId);
  if (!missionStatus) throw new Error("주간 미션을 찾지 못했어요.");
  if (missionStatus.claimed || !missionStatus.completed) {
    return {
      profile,
      status,
      granted: false,
      rewards: { stars: 0 },
      message: missionStatus.claimed
        ? "주간 미션 보상은 이미 받았어요."
        : "아직 주간 미션을 완료하지 못했어요.",
    };
  }

  const nextProfile = { ...profile, stars: profile.stars + missionStatus.rewards.stars };
  const nextStatus = {
    ...status,
    missions: status.missions.map((item) =>
      item.mission.id === missionId ? { ...item, claimed: true, completed: true } : item,
    ),
  };
  localStorage.setItem(
    localKey(LOCAL_WEEKLY_MISSION_PREFIX, profile.uid),
    JSON.stringify(nextStatus),
  );
  await persistPlayerProfile(nextProfile);
  return {
    profile: nextProfile,
    status: nextStatus,
    granted: true,
    rewards: { stars: missionStatus.rewards.stars },
    message: `주간 미션 +${missionStatus.rewards.stars}별`,
  };
}

export async function getStageProgress(profile: PlayerProfile): Promise<StageProgress> {
  const fallback = normalizeStageProgress(
    parseJson(localStorage.getItem(localKey(LOCAL_STAGE_PREFIX, profile.uid)), null),
  );
  try {
    if (profile.authMode !== "firebase") return fallback;
    const result = await callLiveOpsFunction<Record<string, never>, { progress: StageProgress }>(
      "getStageProgress",
      {},
    );
    if (result?.progress) return normalizeStageProgress(result.progress);
    const api = await getFirebaseLiveOpsApi(true);
    if (!api) return fallback;
    const { db, doc, getDoc } = api;
    const snapshot = await getDoc(doc(db, "stageProgress", profile.uid));
    return normalizeStageProgress(snapshot.exists() ? snapshot.data() : null);
  } catch {
    firebaseUnavailable = true;
    return fallback;
  }
}

export async function clearStage(
  profile: PlayerProfile,
  input: { stageId: number; stars: number; score: number },
) {
  if (profile.authMode === "firebase") {
    const result = await callLiveOpsFunction<
      { stageId: number; stars: number },
      { profile: PlayerProfile; progress: StageProgress; rewards: { stars: number } }
    >("clearStage", { stageId: input.stageId, stars: input.stars });
    if (result) return result;
  }

  const current = await getStageProgress(profile);
  const stageId = String(input.stageId);
  const earnedStars = Math.min(3, Math.max(0, Math.round(input.stars)));
  const nextStars = {
    ...current.stars,
    [stageId]: Math.max(current.stars[stageId] || 0, earnedStars),
  };
  const rewardStars = Math.max(0, nextStars[stageId] - (current.stars[stageId] || 0)) * 25;
  const nextProgress = normalizeStageProgress({
    ...current,
    currentStage:
      earnedStars > 0 && input.stageId >= current.currentStage
        ? input.stageId + 1
        : current.currentStage,
    stars: nextStars,
  });
  const nextProfile = { ...profile, stars: profile.stars + rewardStars };

  localStorage.setItem(localKey(LOCAL_STAGE_PREFIX, profile.uid), JSON.stringify(nextProgress));
  await persistPlayerProfile(nextProfile);

  return { progress: nextProgress, profile: nextProfile, rewards: { stars: rewardStars } };
}

export async function getSeasonPassStatus(profile: PlayerProfile): Promise<SeasonPassStatus> {
  const season = await getSeasonCurrent();
  const fallback = buildSeasonPassStatus(
    profile,
    normalizePassClaims(
      parseJson(localStorage.getItem(localKey(LOCAL_PASS_PREFIX, profile.uid)), null),
      season.id,
    ),
    season,
  );

  try {
    if (profile.authMode !== "firebase") return fallback;
    const result = await callLiveOpsFunction<Record<string, never>, SeasonPassStatus>(
      "getSeasonPassStatus",
      {},
    );
    return result || fallback;
  } catch {
    firebaseUnavailable = true;
    return fallback;
  }
}

export async function claimSeasonPassReward(
  profile: PlayerProfile,
  input: { level: number; track: SeasonPassTrack },
): Promise<SeasonPassClaimResult> {
  if (profile.authMode === "firebase") {
    const result = await callLiveOpsFunction<
      { level: number; track: SeasonPassTrack },
      SeasonPassClaimResult
    >("claimSeasonPassReward", input);
    if (result) return result;
  }

  const season = await getSeasonCurrent();
  const rawClaims = normalizePassClaims(
    parseJson(localStorage.getItem(localKey(LOCAL_PASS_PREFIX, profile.uid)), null),
    season.id,
  );
  const tier = passTiers.find((item) => item.level === input.level);
  if (!tier || input.level > passLevelFromXp(profile.xp)) {
    const status = buildSeasonPassStatus(profile, rawClaims, season);
    return {
      profile,
      status,
      granted: false,
      rewards: { label: "잠김" },
      message: "아직 열리지 않은 패스 보상이에요.",
    };
  }
  if (input.track === "premium" && !profile.seasonPassPremium) {
    const status = buildSeasonPassStatus(profile, rawClaims, season);
    return {
      profile,
      status,
      granted: false,
      rewards: tier.premium,
      message: "프리미엄 패스가 필요해요.",
    };
  }
  if (rawClaims[input.track].includes(tier.level)) {
    const status = buildSeasonPassStatus(profile, rawClaims, season);
    return {
      profile,
      status,
      granted: false,
      rewards: tier[input.track],
      message: "이미 받은 패스 보상이에요.",
    };
  }

  const nextClaims = {
    ...rawClaims,
    [input.track]: [...rawClaims[input.track], tier.level].sort((a, b) => a - b),
  };
  const nextProfile = applyPassReward(profile, tier[input.track]);
  const nextStatus = buildSeasonPassStatus(nextProfile, nextClaims, season);
  localStorage.setItem(
    localKey(LOCAL_PASS_PREFIX, profile.uid),
    JSON.stringify({ seasonId: season.id, ...nextClaims }),
  );
  await persistPlayerProfile(nextProfile);

  return {
    profile: nextProfile,
    status: nextStatus,
    granted: true,
    rewards: tier[input.track],
    message: `${tier[input.track].label} 수령 완료`,
  };
}

function buildLocalCharacterDex(profile: PlayerProfile): CharacterDexEntry[] {
  return characterDex.map((character) => ({
    ...character,
    unlocked: profile.unlockedCharacters.includes(character.animal),
    level: profile.characterLevels[character.animal] || 0,
    affinity: profile.characterAffinity[character.animal] || 0,
    plays: profile.characterPlays[character.animal] || 0,
  }));
}

export async function getCharacterDex(profile: PlayerProfile): Promise<CharacterDexEntry[]> {
  const fallback = buildLocalCharacterDex(profile);
  try {
    if (profile.authMode !== "firebase") return fallback;
    const result = await callLiveOpsFunction<
      Record<string, never>,
      { characters: CharacterDexEntry[] }
    >("getCharacterDex", {});
    return Array.isArray(result?.characters) ? result.characters : fallback;
  } catch {
    firebaseUnavailable = true;
    return fallback;
  }
}

export async function setMainCharacter(profile: PlayerProfile, animal: CharacterId) {
  if (profile.authMode === "firebase") {
    const result = await callLiveOpsFunction<{ animal: CharacterId }, { profile: PlayerProfile }>(
      "setMainCharacter",
      { animal },
    );
    if (result) return result.profile;
  }

  if (!profile.unlockedCharacters.includes(animal)) return profile;
  const nextProfile = { ...profile, mainCharacter: animal };
  await persistPlayerProfile(nextProfile);
  return nextProfile;
}

export async function levelUpCharacter(profile: PlayerProfile, animal: CharacterId) {
  if (profile.authMode === "firebase") {
    const result = await callLiveOpsFunction<
      { animal: CharacterId },
      { profile: PlayerProfile; leveled: boolean; cost: number }
    >("levelUpCharacter", { animal });
    if (result) return result;
  }

  if (!profile.unlockedCharacters.includes(animal)) {
    return { profile, leveled: false, cost: 0 };
  }
  const currentLevel = profile.characterLevels[animal] || 1;
  const cost = currentLevel * 80;
  if (profile.stars < cost) return { profile, leveled: false, cost };
  const nextProfile = {
    ...profile,
    stars: profile.stars - cost,
    characterLevels: {
      ...profile.characterLevels,
      [animal]: currentLevel + 1,
    },
  };
  await persistPlayerProfile(nextProfile);
  return { profile: nextProfile, leveled: true, cost };
}

export async function purchaseShopItem(
  profile: PlayerProfile,
  item: ShopItem,
): Promise<ShopPurchaseResult> {
  if (item.currency !== "stars") {
    return {
      profile,
      purchased: false,
      message: "스토어 결제 완료 후 영수증 검증으로 지급돼요.",
    };
  }

  if (profile.authMode === "firebase") {
    const result = await callLiveOpsFunction<{ itemId: string }, ShopPurchaseResult>(
      "purchaseShopItem",
      { itemId: item.id },
    );
    if (result) return result;
  }

  if (profile.stars < item.price) {
    return {
      profile,
      purchased: false,
      message: `별 ${item.price}개가 필요해요.`,
    };
  }

  let nextProfile: PlayerProfile | null = null;

  if (item.category === "hearts") {
    const quantity = item.id.includes("5") ? 5 : 1;
    const hearts = Math.min(MAX_HEARTS, profile.hearts + quantity);
    if (hearts === profile.hearts) {
      return {
        profile,
        purchased: false,
        message: "하트가 이미 가득 찼어요.",
      };
    }
    nextProfile = {
      ...profile,
      hearts,
      stars: profile.stars - item.price,
      lastHeartAt: hearts >= MAX_HEARTS ? Date.now() : profile.lastHeartAt,
    };
  }

  if (item.category === "boosters") {
    const key = item.id.startsWith("shuffle")
      ? "shuffle"
      : item.id.startsWith("time")
        ? "timePlus"
        : "hint";
    const quantity = Number(item.id.match(/\d+/)?.[0] || 1);
    nextProfile = {
      ...profile,
      stars: profile.stars - item.price,
      inventory: {
        ...profile.inventory,
        [key]: (profile.inventory[key] || 0) + quantity,
      },
    };
  }

  if (!nextProfile) {
    return {
      profile,
      purchased: false,
      message: "아직 준비 중인 상품이에요.",
    };
  }

  await persistPlayerProfile(nextProfile);
  return {
    profile: nextProfile,
    purchased: true,
    message: `${item.name} 구매 완료`,
  };
}

export async function verifyIapPurchase(
  profile: PlayerProfile,
  input: IapVerifyInput,
): Promise<IapVerifyResult> {
  if (profile.authMode !== "firebase") {
    throw new Error("Firebase 계정에서만 결제 검증을 사용할 수 있어요.");
  }

  const result = await callLiveOpsFunction<IapVerifyInput, IapVerifyResult>(
    "verifyIapPurchase",
    input,
  );
  if (!result) throw new Error("Firebase callable verifyIapPurchase is unavailable.");
  return result;
}
