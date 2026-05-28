import {
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign as signCrypto,
  timingSafeEqual,
  verify as verifyCrypto,
} from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { GoogleAuth } from "google-auth-library";

initializeApp();

const db = getFirestore();
const auth = getAuth();
let admobKeyCache: { expiresAt: number; keys: Map<string, string> } | null = null;

const MAX_HEARTS = 5;
const HEART_REGEN_MS = 20 * 60 * 1000;
const XP_PER_LEVEL = 1200;
const PASS_XP_PER_LEVEL = 500;
const JWT_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHARACTER_IDS = ["puppy", "cat", "rabbit", "bear", "panda", "chick"] as const;
const AUTH_PROVIDER_IDS = ["anonymous", "google.com", "apple.com", "oidc.kakao"] as const;
const IAP_PLATFORMS = ["ios", "android"] as const;
const PASS_TRACKS = ["free", "premium"] as const;
const COSMETIC_IDS = ["spring-coat", "gold-board"] as const;
const NOTIFICATION_TOPICS = [
  "heart_full",
  "friend_score",
  "daily_reminder",
  "season_ending",
] as const;
const NOTIFICATION_PLATFORMS = ["ios", "android", "web"] as const;
const AD_REWARD_TYPES = ["heart", "timePlus", "coins", "booster"] as const;
const AD_NETWORKS = ["admob", "unity", "internal", "client_verified"] as const;
const ADMOB_SSV_KEYS_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
const REPORT_REASONS = ["cheat", "abuse", "spam", "nickname", "other"] as const;
const EXPERIMENT_KEYS = ["shop_price", "reward_amount", "tutorial_flow"] as const;
const TELEMETRY_EVENTS = [
  "session_start",
  "session_end",
  "match_start",
  "match_finish",
  "purchase",
  "tutorial_step",
  "mission_claim",
  "daily_claim",
  "pass_claim",
  "ad_request",
  "ad_view",
  "ad_reward",
] as const;
const GOOGLE_ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

type CharacterId = (typeof CHARACTER_IDS)[number];
type AuthProviderId = (typeof AUTH_PROVIDER_IDS)[number];
type IapPlatform = (typeof IAP_PLATFORMS)[number];
type PassTrack = (typeof PASS_TRACKS)[number];
type CosmeticId = (typeof COSMETIC_IDS)[number];
type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number];
type NotificationPlatform = (typeof NOTIFICATION_PLATFORMS)[number];
type AdRewardType = (typeof AD_REWARD_TYPES)[number];
type AdNetwork = (typeof AD_NETWORKS)[number];
type ReportReason = (typeof REPORT_REASONS)[number];
type ExperimentKey = (typeof EXPERIMENT_KEYS)[number];
type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];
type ShopCategory = "hearts" | "boosters" | "skins" | "pack";
type ShopCurrency = "stars" | "coins" | "iap";
type MatchMode = "rush" | "stage" | "versus";
type SeasonRewardRange = "weekly" | "all";

interface ReplayMove {
  r: number;
  c: number;
  dir: "up" | "down" | "left" | "right";
  t: number;
}

interface PlayerInventory {
  hint: number;
  hammer: number;
  shuffle: number;
  timePlus: number;
}

interface PlayerProfile {
  uid: string;
  nickname: string;
  hearts: number;
  coins: number;
  bestScore: number;
  totalScore: number;
  lastHeartAt: number;
  inventory: PlayerInventory;
  level: number;
  xp: number;
  stars: number;
  streak: number;
  lastDailyKey: string;
  completedDailyKeys: string[];
  rp: number;
  tier: "BRONZE" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND";
  mainCharacter: CharacterId;
  unlockedCharacters: CharacterId[];
  characterLevels: Partial<Record<CharacterId, number>>;
  characterAffinity: Partial<Record<CharacterId, number>>;
  characterPlays: Partial<Record<CharacterId, number>>;
  cosmetics: CosmeticId[];
  totalPlays: number;
  totalMatches: number;
  maxCombo: number;
  totalSpecials: number;
  authProvider: AuthProviderId;
  linkedProviders: AuthProviderId[];
  seasonPassPremium: boolean;
  vipUntil: number;
  authMode: "firebase";
}

interface PlayerStats {
  uid: string;
  nickname: string;
  tier: PlayerProfile["tier"];
  rp: number;
  mainCharacter: CharacterId;
  level: number;
  xp: number;
  stars: number;
  coins: number;
  hearts: number;
  nextHeartAt: number | null;
  bestScore: number;
  totalScore: number;
  totalPlays: number;
  averageScore: number;
  totalMatches: number;
  maxCombo: number;
  totalSpecials: number;
  streak: number;
  authProvider: AuthProviderId;
  linkedProviders: AuthProviderId[];
  vipUntil: number;
}

interface FriendEntry {
  id: string;
  nickname: string;
  animal: CharacterId;
  bestScore: number;
  online: boolean;
  isOnline: boolean;
  lastSeen: string | null;
}

interface CharacterDexEntry {
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

interface VersusOpponent {
  id: string;
  nickname: string;
  animal: CharacterId;
  rp: number;
  scoreTarget: number;
  isBot: boolean;
}

interface GuildBossState {
  weekId: string;
  hp: number;
  hpMax: number;
}

interface GuildContribution {
  guildId: string;
  damage: number;
  boss: GuildBossState;
}

interface PlayerProgressState {
  level: number;
  xp: number;
  stars: number;
  streak: number;
  lastDailyKey: string;
  completedDailyKeys: string[];
}

interface RunProgressPatch {
  matchId?: string;
  score: number;
  matchedCells: number;
  maxCombo: number;
  specialTriggers: number;
  feverCount: number;
}

interface AdRewardVerification {
  network: AdNetwork;
  verified: boolean;
  mode: "ssv" | "client_verified";
  transactionId?: string;
  adUnit?: string;
  adNetwork?: string;
  rewardItem?: string;
}

type DailyMissionMetric = "score" | "maxCombo" | "specialTriggers" | "feverCount";
type MissionAggregate = "max" | "sum";

interface DailyMission {
  id: string;
  label: string;
  title: string;
  metric: DailyMissionMetric;
  goal: number;
  rewardStars: number;
}

interface DailyMissionState {
  dayKey: string;
  missionId: string;
  progress: number;
  claimed: boolean;
}

interface WeeklyMission extends DailyMission {
  aggregate: MissionAggregate;
}

interface WeeklyMissionProgress {
  progress: number;
  claimed: boolean;
}

interface WeeklyMissionState {
  weekKey: string;
  missions: Record<string, WeeklyMissionProgress>;
}

interface ShopItem {
  id: string;
  category: ShopCategory;
  name: string;
  desc: string;
  price: number;
  currency: ShopCurrency;
  tag?: string;
  productId?: string;
}

interface IapGrant {
  hearts?: number;
  stars?: number;
  coins?: number;
  inventory?: Partial<PlayerInventory>;
  seasonPassPremium?: boolean;
  vipDays?: number;
}

interface SeasonCurrent {
  id: string;
  title: string;
  theme: string;
  startsAt: string;
  endsAt: string;
}

interface PassReward {
  label: string;
  stars?: number;
  coins?: number;
  hearts?: number;
  inventory?: Partial<PlayerInventory>;
  character?: CharacterId;
  cosmetic?: CosmeticId;
}

interface PassTier {
  level: number;
  free: PassReward;
  premium: PassReward;
}

interface PassClaims {
  seasonId: string;
  free: number[];
  premium: number[];
}

interface VerifiedIapPurchase {
  platform: IapPlatform;
  productId: string;
  transactionId: string;
  quantity: number;
  environment: "production" | "sandbox" | "unknown";
  orderId?: string;
  tokenHash?: string;
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

const iapGrants: Record<string, IapGrant> = {
  starter_pack: {
    hearts: 5,
    stars: 300,
    inventory: { hint: 5, hammer: 1, shuffle: 3, timePlus: 2 },
  },
  season_pass_s2: {
    seasonPassPremium: true,
    stars: 100,
  },
  vip_monthly: {
    vipDays: 30,
    hearts: 5,
    stars: 300,
  },
};

const fallbackExperiments: Record<ExperimentKey, string[]> = {
  shop_price: ["control", "starter_bonus"],
  reward_amount: ["control", "generous_daily"],
  tutorial_flow: ["control", "fast_skip"],
};

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

const passTiers: PassTier[] = [
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

const versusBots: VersusOpponent[] = [
  { id: "bot-momo", nickname: "모모", animal: "rabbit", rp: 980, scoreTarget: 14500, isBot: true },
  {
    id: "bot-pang",
    nickname: "판다킹",
    animal: "panda",
    rp: 1120,
    scoreTarget: 19000,
    isBot: true,
  },
  {
    id: "bot-bear",
    nickname: "곰돌장인",
    animal: "bear",
    rp: 1320,
    scoreTarget: 26000,
    isBot: true,
  },
  { id: "bot-chick", nickname: "삐약", animal: "chick", rp: 860, scoreTarget: 10500, isBot: true },
];

function assertAuthed(uid?: string) {
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요해요.");
  return uid;
}

function clampInt(value: unknown, fallback = 0, min = 0, max = 99999999) {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && CHARACTER_IDS.includes(value as CharacterId);
}

function isAuthProviderId(value: unknown): value is AuthProviderId {
  return typeof value === "string" && AUTH_PROVIDER_IDS.includes(value as AuthProviderId);
}

function isIapPlatform(value: unknown): value is IapPlatform {
  return typeof value === "string" && IAP_PLATFORMS.includes(value as IapPlatform);
}

function isMatchMode(value: unknown): value is MatchMode {
  return value === "rush" || value === "stage" || value === "versus";
}

function isPassTrack(value: unknown): value is PassTrack {
  return typeof value === "string" && PASS_TRACKS.includes(value as PassTrack);
}

function isCosmeticId(value: unknown): value is CosmeticId {
  return typeof value === "string" && COSMETIC_IDS.includes(value as CosmeticId);
}

function isNotificationTopic(value: unknown): value is NotificationTopic {
  return typeof value === "string" && NOTIFICATION_TOPICS.includes(value as NotificationTopic);
}

function isNotificationPlatform(value: unknown): value is NotificationPlatform {
  return (
    typeof value === "string" && NOTIFICATION_PLATFORMS.includes(value as NotificationPlatform)
  );
}

function isAdRewardType(value: unknown): value is AdRewardType {
  return typeof value === "string" && AD_REWARD_TYPES.includes(value as AdRewardType);
}

function isAdNetwork(value: unknown): value is AdNetwork {
  return typeof value === "string" && AD_NETWORKS.includes(value as AdNetwork);
}

function isReportReason(value: unknown): value is ReportReason {
  return typeof value === "string" && REPORT_REASONS.includes(value as ReportReason);
}

function isTelemetryEventName(value: unknown): value is TelemetryEventName {
  return typeof value === "string" && TELEMETRY_EVENTS.includes(value as TelemetryEventName);
}

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function weekKey(date = new Date()) {
  const localDay = dayKey(date);
  const localDate = new Date(`${localDay}T00:00:00+09:00`);
  const day = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(localDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((localDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${localDate.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function tomorrowKstIso(today = dayKey()) {
  const date = new Date(`${today}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function nextWeekKstIso(date = new Date()) {
  const localDay = dayKey(date);
  const localDate = new Date(`${localDay}T00:00:00+09:00`);
  const day = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() + (8 - day));
  return localDate.toISOString();
}

function sanitizeNickname(value: unknown) {
  const name = typeof value === "string" ? value.trim().slice(0, 12) : "";
  return name || "게스트";
}

function previousDayKey(currentKey: string) {
  const date = new Date(`${currentKey}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() - 1);
  return dayKey(date);
}

function readEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || "";
}

function liveOpsAdminUids() {
  return readEnv("LIVEOPS_ADMIN_UIDS")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertLiveOpsAdmin(uid: string) {
  const admins = liveOpsAdminUids();
  if (!admins.length || !admins.includes(uid)) {
    throw new HttpsError("permission-denied", "운영 관리자만 사용할 수 있어요.");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableVariant(uid: string, key: ExperimentKey, variants: string[]) {
  const cleanVariants = variants.filter(Boolean);
  if (!cleanVariants.length) return "control";
  const bucket = parseInt(sha256(`${uid}:${key}`).slice(0, 8), 16);
  return cleanVariants[bucket % cleanVariants.length];
}

function sanitizeSeasonRewardRange(value: unknown): SeasonRewardRange {
  return value === "all" ? "all" : "weekly";
}

function sanitizeSeasonRewardId(value: unknown, fallback: string) {
  const raw = typeof value === "string" ? value.trim().slice(0, 80) : "";
  return raw.replace(/[^A-Za-z0-9:_-]/g, "") || fallback;
}

function createMatchId(uid: string) {
  return `m_${sha256(`${uid}:${Date.now()}:${randomBytes(12).toString("hex")}`).slice(0, 28)}`;
}

function createServerMatchSeed(uid: string, matchId: string) {
  return `server:${sha256(`${uid}:${matchId}:${Date.now()}:${randomBytes(16).toString("hex")}`)}`;
}

function createVersusMatchId(uid: string) {
  return `v_${sha256(`${uid}:versus:${Date.now()}:${randomBytes(12).toString("hex")}`).slice(0, 28)}`;
}

function sanitizeMatchId(value: unknown, uid: string) {
  if (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 120 &&
    /^[A-Za-z0-9:_-]+$/.test(value)
  ) {
    return value;
  }
  return createMatchId(uid);
}

function createRestoreCodeValue() {
  return randomBytes(5)
    .toString("base64url")
    .replace(/[^A-Z0-9]/gi, "")
    .slice(0, 6)
    .toUpperCase();
}

function createFriendCodeValue() {
  return randomBytes(5)
    .toString("base64url")
    .replace(/[^A-Z0-9]/gi, "")
    .slice(0, 6)
    .toUpperCase();
}

function createGuildId() {
  return `g_${randomBytes(8)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 12)}`;
}

function sanitizeRestoreCode(value: unknown) {
  const code = typeof value === "string" ? value.replace(/[^A-Z0-9]/gi, "").toUpperCase() : "";
  if (code.length !== 6) {
    throw new HttpsError("invalid-argument", "복원 코드는 6자리여야 해요.");
  }
  return code;
}

function sanitizeFriendCode(value: unknown) {
  const code = typeof value === "string" ? value.replace(/[^A-Z0-9]/gi, "").toUpperCase() : "";
  if (code.length !== 6) {
    throw new HttpsError("invalid-argument", "친구 코드는 6자리여야 해요.");
  }
  return code;
}

function sanitizeUid(value: unknown) {
  if (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 128 &&
    /^[A-Za-z0-9:_-]+$/.test(value)
  ) {
    return value;
  }
  throw new HttpsError("invalid-argument", "유저 ID가 올바르지 않아요.");
}

function sanitizeOptionalText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sanitizeHashList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-f0-9]{32,128}$|^[a-z0-9_-]{22,128}$/i.test(item))
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 50);
}

function sanitizeReportReason(value: unknown): ReportReason {
  return isReportReason(value) ? value : "other";
}

function sanitizeGuildId(value: unknown) {
  if (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 32 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return value;
  }
  throw new HttpsError("invalid-argument", "길드 ID가 올바르지 않아요.");
}

function sanitizeGuildName(value: unknown) {
  const name = typeof value === "string" ? value.trim().slice(0, 16) : "";
  if (name.length < 2) throw new HttpsError("invalid-argument", "길드 이름은 2자 이상이에요.");
  return name;
}

function sanitizeGuildDescription(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeBase64UrlJson(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

function jwtSecret() {
  const secret = readEnv("JWT_SESSION_SECRET");
  if (!secret || secret.length < 32) {
    throw new HttpsError("failed-precondition", "JWT_SESSION_SECRET은 32자 이상이어야 해요.");
  }
  return secret;
}

function signSessionJwt(payload: Record<string, unknown>) {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const body = base64UrlJson(payload);
  const signingInput = `${header}.${body}`;
  const signature = createHmac("sha256", jwtSecret()).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function safeCompareText(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function verifySessionJwt(token: unknown) {
  if (typeof token !== "string") {
    throw new HttpsError("unauthenticated", "accessToken이 필요해요.");
  }
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) {
    throw new HttpsError("unauthenticated", "accessToken 형식이 올바르지 않아요.");
  }
  const expected = createHmac("sha256", jwtSecret())
    .update(`${header}.${body}`)
    .digest("base64url");
  if (!safeCompareText(expected, signature)) {
    throw new HttpsError("unauthenticated", "accessToken 서명이 올바르지 않아요.");
  }
  const payload = decodeBase64UrlJson(body);
  if (payload.typ !== "access" || typeof payload.sub !== "string") {
    throw new HttpsError("unauthenticated", "accessToken 클레임이 올바르지 않아요.");
  }
  const exp = clampInt(payload.exp, 0, 0, Number.MAX_SAFE_INTEGER);
  if (exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpsError("unauthenticated", "accessToken이 만료됐어요.");
  }
  return payload as { sub: string; jti?: string; exp: number };
}

function bearerToken(authHeader: unknown) {
  if (typeof authHeader !== "string") return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function sanitizeAuthProviderKey(value: unknown): AuthProviderId | "guest" {
  if (value === "guest") return "guest";
  if (value === "google") return "google.com";
  if (value === "apple") return "apple.com";
  if (value === "kakao") return "oidc.kakao";
  return isAuthProviderId(value) ? value : "anonymous";
}

function defaultProfile(uid: string): PlayerProfile {
  return {
    uid,
    nickname: "게스트",
    hearts: MAX_HEARTS,
    coins: 0,
    bestScore: 0,
    totalScore: 0,
    lastHeartAt: Date.now(),
    inventory: { hint: 2, hammer: 0, shuffle: 1, timePlus: 1 },
    level: 1,
    xp: 0,
    stars: 0,
    streak: 0,
    lastDailyKey: "",
    completedDailyKeys: [],
    rp: 1000,
    tier: "BRONZE",
    mainCharacter: "puppy",
    unlockedCharacters: ["puppy"],
    characterLevels: { puppy: 1, cat: 0, rabbit: 0, bear: 0, panda: 0, chick: 0 },
    characterAffinity: { puppy: 0, cat: 0, rabbit: 0, bear: 0, panda: 0, chick: 0 },
    characterPlays: { puppy: 0, cat: 0, rabbit: 0, bear: 0, panda: 0, chick: 0 },
    cosmetics: [],
    totalPlays: 0,
    totalMatches: 0,
    maxCombo: 0,
    totalSpecials: 0,
    authProvider: "anonymous",
    linkedProviders: ["anonymous"],
    seasonPassPremium: false,
    vipUntil: 0,
    authMode: "firebase",
  };
}

function normalizeCharacterList(value: unknown): CharacterId[] {
  if (!Array.isArray(value)) return ["puppy"];
  const unlocked = value
    .filter(isCharacterId)
    .filter((item, index, list) => list.indexOf(item) === index);
  return unlocked.includes("puppy") ? unlocked : ["puppy", ...unlocked];
}

function normalizeCharacterMap(value: unknown, fallback = 0, max = 999999) {
  const source = (value || {}) as Partial<Record<CharacterId, unknown>>;
  return CHARACTER_IDS.reduce<Partial<Record<CharacterId, number>>>((result, character) => {
    result[character] = clampInt(source[character], fallback, 0, max);
    return result;
  }, {});
}

function normalizeLinkedProviders(value: unknown): AuthProviderId[] {
  if (!Array.isArray(value)) return ["anonymous"];
  const providers = value.filter(isAuthProviderId).filter((item, index, list) => {
    return list.indexOf(item) === index;
  });
  return providers.length ? providers : ["anonymous"];
}

function normalizeCosmetics(value: unknown): CosmeticId[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCosmeticId).filter((item, index, list) => list.indexOf(item) === index);
}

function normalizeNotificationTopics(value: unknown): NotificationTopic[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isNotificationTopic)
    .filter((item, index, list) => list.indexOf(item) === index);
}

function sanitizeTelemetryPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, 24)
      .map(([key, item]) => {
        const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);
        if (typeof item === "number") return [safeKey, clampInt(item, 0, -999999999, 999999999)];
        if (typeof item === "boolean") return [safeKey, item];
        if (typeof item === "string") return [safeKey, item.slice(0, 120)];
        return [safeKey, String(item).slice(0, 120)];
      })
      .filter(([key]) => key),
  );
}

async function getAccountProviderPatch(
  uid: string,
): Promise<Pick<PlayerProfile, "authProvider" | "linkedProviders">> {
  try {
    const user = await auth.getUser(uid);
    const linked = user.providerData
      .map((provider) => provider.providerId)
      .filter(isAuthProviderId)
      .filter((item, index, list) => list.indexOf(item) === index);
    const linkedProviders = linked.length ? linked : (["anonymous"] satisfies AuthProviderId[]);
    const authProvider: AuthProviderId =
      linkedProviders.find((provider) => provider !== "anonymous") || "anonymous";
    return { authProvider, linkedProviders };
  } catch {
    return {
      authProvider: "anonymous" as const,
      linkedProviders: ["anonymous"] as AuthProviderId[],
    };
  }
}

function normalizeProfile(
  uid: string,
  raw: FirebaseFirestore.DocumentData | undefined,
): PlayerProfile {
  const base = defaultProfile(uid);
  if (!raw) return base;
  const unlockedCharacters = normalizeCharacterList(raw.unlockedCharacters);
  const mainCharacter =
    isCharacterId(raw.mainCharacter) && unlockedCharacters.includes(raw.mainCharacter)
      ? raw.mainCharacter
      : "puppy";
  return {
    ...base,
    nickname: typeof raw.nickname === "string" ? raw.nickname.slice(0, 12) : base.nickname,
    hearts: clampInt(raw.hearts, base.hearts, 0, MAX_HEARTS),
    coins: clampInt(raw.coins, 0),
    bestScore: clampInt(raw.bestScore, 0),
    totalScore: clampInt(raw.totalScore, 0, 0, 999999999),
    lastHeartAt: clampInt(raw.lastHeartAt, Date.now()),
    inventory: {
      hint: clampInt(raw.inventory?.hint, base.inventory.hint, 0, 999),
      hammer: clampInt(raw.inventory?.hammer, base.inventory.hammer, 0, 999),
      shuffle: clampInt(raw.inventory?.shuffle, base.inventory.shuffle, 0, 999),
      timePlus: clampInt(raw.inventory?.timePlus, base.inventory.timePlus, 0, 999),
    },
    level: clampInt(raw.level, 1, 1, 999),
    xp: clampInt(raw.xp, 0),
    stars: clampInt(raw.stars, 0),
    streak: clampInt(raw.streak, 0, 0, 9999),
    lastDailyKey: typeof raw.lastDailyKey === "string" ? raw.lastDailyKey.slice(0, 10) : "",
    completedDailyKeys: Array.isArray(raw.completedDailyKeys)
      ? raw.completedDailyKeys
          .filter((key: unknown): key is string => typeof key === "string")
          .slice(-31)
      : [],
    rp: clampInt(raw.rp, base.rp),
    tier:
      raw.tier === "SILVER" ||
      raw.tier === "GOLD" ||
      raw.tier === "PLATINUM" ||
      raw.tier === "DIAMOND"
        ? raw.tier
        : "BRONZE",
    mainCharacter,
    unlockedCharacters,
    characterLevels: normalizeCharacterMap(raw.characterLevels, 0, 99),
    characterAffinity: normalizeCharacterMap(raw.characterAffinity),
    characterPlays: normalizeCharacterMap(raw.characterPlays),
    cosmetics: normalizeCosmetics(raw.cosmetics),
    totalPlays: clampInt(raw.totalPlays, 0),
    totalMatches: clampInt(raw.totalMatches, 0),
    maxCombo: clampInt(raw.maxCombo, 0, 0, 999),
    totalSpecials: clampInt(raw.totalSpecials, 0),
    authProvider: isAuthProviderId(raw.authProvider) ? raw.authProvider : "anonymous",
    linkedProviders: normalizeLinkedProviders(raw.linkedProviders),
    seasonPassPremium: raw.seasonPassPremium === true,
    vipUntil: clampInt(raw.vipUntil, 0, 0, 4102444800000),
  };
}

function recoverHearts(profile: PlayerProfile, now = Date.now()) {
  if (profile.hearts >= MAX_HEARTS) return { ...profile, hearts: MAX_HEARTS, lastHeartAt: now };
  const gained = Math.floor(Math.max(0, now - profile.lastHeartAt) / HEART_REGEN_MS);
  if (gained <= 0) return profile;
  const hearts = Math.min(MAX_HEARTS, profile.hearts + gained);
  return {
    ...profile,
    hearts,
    lastHeartAt: hearts >= MAX_HEARTS ? now : profile.lastHeartAt + gained * HEART_REGEN_MS,
  };
}

function getNextHeartAt(profile: PlayerProfile) {
  if (profile.hearts >= MAX_HEARTS) return null;
  return profile.lastHeartAt + HEART_REGEN_MS;
}

function buildPlayerStats(profile: PlayerProfile): PlayerStats {
  const readyProfile = recoverHearts(profile);
  return {
    uid: readyProfile.uid,
    nickname: readyProfile.nickname,
    tier: readyProfile.tier,
    rp: readyProfile.rp,
    mainCharacter: readyProfile.mainCharacter,
    level: readyProfile.level,
    xp: readyProfile.xp,
    stars: readyProfile.stars,
    coins: readyProfile.coins,
    hearts: readyProfile.hearts,
    nextHeartAt: getNextHeartAt(readyProfile),
    bestScore: readyProfile.bestScore,
    totalScore: readyProfile.totalScore,
    totalPlays: readyProfile.totalPlays,
    averageScore:
      readyProfile.totalPlays > 0
        ? Math.round(readyProfile.totalScore / readyProfile.totalPlays)
        : 0,
    totalMatches: readyProfile.totalMatches,
    maxCombo: readyProfile.maxCombo,
    totalSpecials: readyProfile.totalSpecials,
    streak: readyProfile.streak,
    authProvider: readyProfile.authProvider,
    linkedProviders: readyProfile.linkedProviders,
    vipUntil: readyProfile.vipUntil,
  };
}

function timestampToIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toISOString();
  }
  if (typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    return new Date(value.toMillis() as number).toISOString();
  }
  return null;
}

function exportValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return (value.toDate() as Date).toISOString();
  }
  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    return new Date(value.toMillis() as number).toISOString();
  }
  if (Array.isArray(value)) return value.map(exportValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        exportValue(entry),
      ]),
    );
  }
  return value;
}

function exportDoc(snapshot: FirebaseFirestore.DocumentSnapshot) {
  return snapshot.exists ? exportValue(snapshot.data() || {}) : null;
}

function exportDocs(snapshot: FirebaseFirestore.QuerySnapshot) {
  return snapshot.docs.map((doc) => ({ id: doc.id, data: exportValue(doc.data()) }));
}

function timestampToMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    return value.toMillis() as number;
  }
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return (value.toDate() as Date).getTime();
  }
  return null;
}

function safeCompareHex(expected: string, actual: string) {
  if (!/^[a-f0-9]{64}$/i.test(expected) || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function adRewardSignaturePayload(input: {
  uid: string;
  rewardId: string;
  rewardType: AdRewardType;
  timestamp: number;
  nonce: string;
}) {
  return `${input.uid}:${input.rewardId}:${input.rewardType}:${input.timestamp}:${input.nonce}`;
}

function verifyAdRewardSignature(input: {
  uid: string;
  rewardId: string;
  rewardType: AdRewardType;
  adNetwork?: unknown;
  signature?: unknown;
  timestamp?: unknown;
  nonce?: unknown;
}) {
  const network = isAdNetwork(input.adNetwork) ? input.adNetwork : "client_verified";
  const secret = readEnv("AD_REWARD_SSV_SECRET");
  if (!secret && network === "client_verified") {
    return { network, verified: false, mode: "client_verified" as const };
  }
  if (!secret) {
    throw new HttpsError("failed-precondition", "광고 SSV 비밀키가 설정되지 않았어요.");
  }
  const signature = typeof input.signature === "string" ? input.signature.trim() : "";
  const nonce = typeof input.nonce === "string" ? input.nonce.replace(/[^A-Za-z0-9:_-]/g, "") : "";
  const timestamp = clampInt(input.timestamp, 0, 0, 4102444800000);
  if (!signature || !nonce || !timestamp) {
    throw new HttpsError("invalid-argument", "광고 검증 서명이 필요해요.");
  }
  if (Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
    throw new HttpsError("deadline-exceeded", "광고 검증 시간이 만료됐어요.");
  }
  const payload = adRewardSignaturePayload({
    uid: input.uid,
    rewardId: input.rewardId,
    rewardType: input.rewardType,
    timestamp,
    nonce,
  });
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (!safeCompareHex(expected, signature)) {
    throw new HttpsError("permission-denied", "광고 검증 서명이 올바르지 않아요.");
  }
  return { network, verified: true, mode: "ssv" as const };
}

function firstQueryValue(value: unknown) {
  const item = Array.isArray(value) ? value[0] : value;
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  return "";
}

function queryValue(query: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = firstQueryValue(query?.[key]);
    if (value) return value;
  }
  return "";
}

function requestRawQuery(request: { url: string; originalUrl?: string }) {
  const rawUrl = typeof request.originalUrl === "string" ? request.originalUrl : request.url;
  const queryIndex = rawUrl.indexOf("?");
  return queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : "";
}

function adRewardTypeFromProvider(value: unknown): AdRewardType {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  if (normalized.includes("heart")) return "heart";
  if (normalized.includes("time") || normalized.includes("second")) return "timePlus";
  if (normalized.includes("boost") || normalized.includes("hint")) return "booster";
  if (normalized.includes("coin") || normalized.includes("star")) return "coins";
  return "coins";
}

async function getAdMobPublicKeys() {
  if (admobKeyCache && admobKeyCache.expiresAt > Date.now()) return admobKeyCache.keys;
  const response = await fetch(ADMOB_SSV_KEYS_URL);
  if (!response.ok) {
    throw new HttpsError("unavailable", "AdMob SSV 공개키를 가져오지 못했어요.");
  }
  const payload = (await response.json()) as {
    keys?: Array<{ keyId?: string | number; pem?: string; base64?: string }>;
  };
  const keys = new Map<string, string>();
  for (const key of payload.keys || []) {
    const keyId = typeof key.keyId === "number" ? String(key.keyId) : key.keyId || "";
    const pem =
      typeof key.pem === "string" && key.pem.includes("BEGIN PUBLIC KEY")
        ? key.pem
        : typeof key.base64 === "string"
          ? `-----BEGIN PUBLIC KEY-----\n${key.base64}\n-----END PUBLIC KEY-----`
          : "";
    if (keyId && pem) keys.set(keyId, pem);
  }
  if (!keys.size) throw new HttpsError("unavailable", "AdMob SSV 공개키가 비어 있어요.");
  admobKeyCache = { keys, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
  return keys;
}

async function verifyAdMobSsvCallback(
  rawQuery: string,
  query: Record<string, unknown> | undefined,
) {
  const signatureParam = "signature=";
  const keyIdParam = "key_id=";
  const signatureIndex = rawQuery.indexOf(signatureParam);
  if (signatureIndex <= 0) {
    throw new HttpsError("invalid-argument", "AdMob SSV signature 파라미터가 필요해요.");
  }
  const signedContent = rawQuery.slice(0, signatureIndex - 1);
  const signatureAndKey = rawQuery.slice(signatureIndex);
  const keyIdIndex = signatureAndKey.indexOf(keyIdParam);
  if (keyIdIndex <= signatureParam.length) {
    throw new HttpsError("invalid-argument", "AdMob SSV key_id 파라미터가 필요해요.");
  }
  const signature = signatureAndKey.slice(signatureParam.length, keyIdIndex - 1);
  const keyId = signatureAndKey.slice(keyIdIndex + keyIdParam.length).split("&")[0];
  const keys = await getAdMobPublicKeys();
  const pem = keys.get(keyId);
  if (!pem) throw new HttpsError("permission-denied", "AdMob SSV 공개키 ID가 올바르지 않아요.");

  const verified = verifyCrypto(
    "sha256",
    Buffer.from(signedContent, "utf8"),
    { key: pem, dsaEncoding: "der" },
    Buffer.from(signature, "base64url"),
  );
  if (!verified) throw new HttpsError("permission-denied", "AdMob SSV 서명이 올바르지 않아요.");

  const transactionId = queryValue(query, "transaction_id");
  const uid = queryValue(query, "user_id");
  if (!transactionId || !uid) {
    throw new HttpsError("invalid-argument", "AdMob SSV transaction_id와 user_id가 필요해요.");
  }
  return {
    uid,
    transactionId,
    rewardType: adRewardTypeFromProvider(queryValue(query, "reward_item")),
    rewardAmount: clampInt(queryValue(query, "reward_amount"), 1, 1, 1000),
    verification: {
      network: "admob" as const,
      verified: true,
      mode: "ssv" as const,
      transactionId,
      adUnit: queryValue(query, "ad_unit"),
      adNetwork: queryValue(query, "ad_network"),
      rewardItem: queryValue(query, "reward_item"),
    },
  };
}

function verifyUnityLevelPlaySsv(query: Record<string, unknown> | undefined) {
  const secret = readEnv("UNITY_LEVELPLAY_SSV_SECRET");
  if (!secret) {
    throw new HttpsError("failed-precondition", "Unity LevelPlay SSV 비밀키가 설정되지 않았어요.");
  }
  const timestamp = queryValue(query, "timestamp", "Timestamp", "TIMESTAMP");
  const transactionId = queryValue(query, "eventId", "event_id", "EVENT_ID");
  const uid = queryValue(query, "userId", "userid", "USER_ID");
  const rewards = queryValue(query, "rewards", "reward_amount", "REWARDS");
  const signature = queryValue(query, "signature", "Signature", "SIGNATURE").toLowerCase();
  if (!timestamp || !transactionId || !uid || !rewards || !signature) {
    throw new HttpsError("invalid-argument", "Unity LevelPlay SSV 필수 파라미터가 부족해요.");
  }
  const expected = createHash("md5")
    .update(`${timestamp}${transactionId}${uid}${rewards}${secret}`)
    .digest("hex");
  if (!safeCompareText(expected, signature)) {
    throw new HttpsError("permission-denied", "Unity LevelPlay SSV 서명이 올바르지 않아요.");
  }
  return {
    uid,
    transactionId,
    rewardType: adRewardTypeFromProvider(queryValue(query, "itemName", "item_name", "reward_item")),
    rewardAmount: clampInt(rewards, 1, 1, 1000),
    verification: {
      network: "unity" as const,
      verified: true,
      mode: "ssv" as const,
      transactionId,
      adUnit: queryValue(query, "placementName", "placement_name"),
      adNetwork: queryValue(query, "adNetwork", "ad_network"),
      rewardItem: queryValue(query, "itemName", "item_name", "reward_item"),
    },
  };
}

function verifyUnityLegacySsv(query: Record<string, unknown> | undefined) {
  const secret = readEnv("UNITY_ADS_SSV_SECRET");
  if (!secret) {
    throw new HttpsError("failed-precondition", "Unity Ads SSV 비밀키가 설정되지 않았어요.");
  }
  const hmac = queryValue(query, "hmac").toLowerCase();
  const entries = Object.entries(query || {})
    .filter(([key]) => key !== "hmac")
    .map(([key, value]) => [key, firstQueryValue(value)] as const)
    .filter(([, value]) => value)
    .sort(([left], [right]) => left.localeCompare(right));
  const signedContent = entries.map(([key, value]) => `${key}=${value}`).join(",");
  const expected = createHmac("md5", secret).update(signedContent).digest("hex");
  if (!hmac || !safeCompareText(expected, hmac)) {
    throw new HttpsError("permission-denied", "Unity Ads SSV 서명이 올바르지 않아요.");
  }
  const uid = queryValue(query, "sid", "user_id", "userid");
  const transactionId = queryValue(query, "oid", "eventId", "event_id");
  if (!uid || !transactionId) {
    throw new HttpsError("invalid-argument", "Unity Ads SSV sid/oid 파라미터가 필요해요.");
  }
  return {
    uid,
    transactionId,
    rewardType: adRewardTypeFromProvider(queryValue(query, "product", "reward_item")),
    rewardAmount: clampInt(queryValue(query, "amount", "rewards"), 1, 1, 1000),
    verification: {
      network: "unity" as const,
      verified: true,
      mode: "ssv" as const,
      transactionId,
      adUnit: queryValue(query, "placement", "placementName"),
      adNetwork: "unity",
      rewardItem: queryValue(query, "product", "reward_item"),
    },
  };
}

function verifyUnitySsvCallback(query: Record<string, unknown> | undefined) {
  return queryValue(query, "hmac") ? verifyUnityLegacySsv(query) : verifyUnityLevelPlaySsv(query);
}

async function grantAdReward(input: {
  uid: string;
  rewardId: string;
  rewardType: AdRewardType;
  rewardAmount?: number;
  verification: AdRewardVerification;
}) {
  const uid = sanitizeUid(input.uid);
  const today = dayKey();
  const rewardId = input.rewardId.replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 120);
  if (!rewardId) throw new HttpsError("invalid-argument", "광고 보상 ID가 필요해요.");
  const hasRewardAmount =
    typeof input.rewardAmount === "number" && Number.isFinite(input.rewardAmount);
  const quantity = clampInt(input.rewardAmount, 1, 1, 1000);

  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const counterRef = db.doc(`adRewardCounters/${uid}_${today}`);
    const rewardRef = db.doc(`adRewards/${uid}_${sha256(rewardId).slice(0, 24)}`);
    const [counterSnapshot, rewardSnapshot] = await Promise.all([
      tx.get(counterRef),
      tx.get(rewardRef),
    ]);
    if (rewardSnapshot.exists) {
      return { granted: false, alreadyGranted: true, profile: publicProfile(profile), rewards: {} };
    }
    const count = clampInt(counterSnapshot.data()?.count, 0, 0, 999);
    if (count >= 10) throw new HttpsError("resource-exhausted", "오늘 광고 보상을 모두 받았어요.");

    const inventory = { ...profile.inventory };
    const rewards: Record<string, number> = {};
    let nextProfile = { ...profile };
    if (input.rewardType === "heart") {
      const hearts = Math.min(MAX_HEARTS, nextProfile.hearts + Math.min(quantity, 5));
      rewards.hearts = hearts - nextProfile.hearts;
      nextProfile = { ...nextProfile, hearts };
    } else if (input.rewardType === "coins") {
      const coins = hasRewardAmount ? clampInt(input.rewardAmount, 30, 1, 1000) : 30;
      nextProfile = {
        ...nextProfile,
        coins: clampInt(nextProfile.coins + coins, nextProfile.coins),
      };
      rewards.coins = coins;
    } else if (input.rewardType === "timePlus") {
      const timePlus = Math.min(quantity, 10);
      inventory.timePlus = clampInt(inventory.timePlus + timePlus, inventory.timePlus, 0, 999);
      rewards.timePlus = timePlus;
    } else {
      const boosters = Math.min(quantity, 10);
      inventory.hint = clampInt(inventory.hint + boosters, inventory.hint, 0, 999);
      rewards.hint = boosters;
    }
    nextProfile = { ...nextProfile, inventory };

    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      counterRef,
      {
        userId: uid,
        dayKey: today,
        count: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(rewardRef, {
      userId: uid,
      rewardType: input.rewardType,
      rewardId,
      verification: input.verification,
      rewards,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { granted: true, alreadyGranted: false, profile: publicProfile(nextProfile), rewards };
  });
}

async function grantAdMobSsvReward(request: {
  query?: Record<string, unknown>;
  url: string;
  originalUrl?: string;
}) {
  const verified = await verifyAdMobSsvCallback(requestRawQuery(request), request.query);
  return grantAdReward({
    uid: verified.uid,
    rewardId: verified.transactionId,
    rewardType: verified.rewardType,
    rewardAmount: verified.rewardAmount,
    verification: verified.verification,
  });
}

async function grantUnitySsvReward(request: { query?: Record<string, unknown> }) {
  const verified = verifyUnitySsvCallback(request.query);
  const result = await grantAdReward({
    uid: verified.uid,
    rewardId: verified.transactionId,
    rewardType: verified.rewardType,
    rewardAmount: verified.rewardAmount,
    verification: verified.verification,
  });
  return { ...result, rewardId: verified.transactionId };
}

function publicFriendEntry(
  profile: PlayerProfile,
  raw?: FirebaseFirestore.DocumentData,
): FriendEntry {
  const lastSeen = timestampToIso(raw?.lastLoginAt) || timestampToIso(raw?.updatedAt);
  return {
    id: profile.uid,
    nickname: profile.nickname,
    animal: profile.mainCharacter,
    bestScore: profile.bestScore,
    online: false,
    isOnline: false,
    lastSeen,
  };
}

function currentGuildBoss(
  raw: FirebaseFirestore.DocumentData | undefined,
  level = 1,
): GuildBossState {
  const weekId = weekKey();
  const hpMax = 500000 + Math.max(0, level - 1) * 50000;
  const boss = raw?.boss || {};
  if (boss.weekId === weekId) {
    return {
      weekId,
      hp: clampInt(boss.hp, hpMax, 0, hpMax),
      hpMax: clampInt(boss.hpMax, hpMax, 1, 999999999),
    };
  }
  return { weekId, hp: hpMax, hpMax };
}

function publicGuild(guildId: string, raw: FirebaseFirestore.DocumentData | undefined) {
  const level = clampInt(raw?.level, 1, 1, 999);
  const boss = currentGuildBoss(raw, level);
  return {
    id: guildId,
    name: typeof raw?.name === "string" ? raw.name.slice(0, 16) : "새 길드",
    description:
      typeof raw?.description === "string" ? raw.description.slice(0, 80) : "함께 보스를 공략해요.",
    ownerId: typeof raw?.ownerId === "string" ? raw.ownerId : "",
    level,
    memberCount: clampInt(raw?.memberCount, 1, 0, 30),
    weeklyScore: clampInt(raw?.weeklyScore, 0, 0, 999999999),
    rank: clampInt(raw?.rank, 0, 0, 999999),
    boss,
  };
}

function publicGuildMember(
  uid: string,
  raw: FirebaseFirestore.DocumentData | undefined,
  fallback?: PlayerProfile,
) {
  const role = raw?.role === "leader" ? "leader" : "member";
  return {
    id: uid,
    nickname:
      typeof raw?.nickname === "string"
        ? raw.nickname.slice(0, 12)
        : fallback?.nickname || "게스트",
    animal: isCharacterId(raw?.animal) ? raw.animal : fallback?.mainCharacter || "puppy",
    role,
    weeklyContribution: clampInt(raw?.weeklyContribution, 0, 0, 999999999),
    joinedAt: timestampToIso(raw?.joinedAt),
  };
}

function tierFromRp(rp: number): PlayerProfile["tier"] {
  if (rp >= 2600) return "DIAMOND";
  if (rp >= 2100) return "PLATINUM";
  if (rp >= 1600) return "GOLD";
  if (rp >= 1200) return "SILVER";
  return "BRONZE";
}

function randomInt(min: number, max: number) {
  const span = Math.max(1, max - min + 1);
  return min + (randomBytes(4).readUInt32BE(0) % span);
}

function botOpponentFor(profile: PlayerProfile): VersusOpponent {
  const sorted = [...versusBots].sort(
    (a, b) => Math.abs(a.rp - profile.rp) - Math.abs(b.rp - profile.rp),
  );
  const bot = sorted[randomInt(0, Math.min(2, sorted.length - 1))] || sorted[0];
  const scoreTarget = clampInt(
    Math.max(bot.scoreTarget, profile.bestScore * 0.82) + randomInt(-1800, 2200),
    bot.scoreTarget,
    3000,
    9999999,
  );
  return { ...bot, scoreTarget };
}

async function pickVersusOpponent(uid: string, profile: PlayerProfile): Promise<VersusOpponent> {
  const friendSnapshot = await db.collection(`friends/${uid}/items`).limit(20).get();
  const friendIds = friendSnapshot.docs.map((doc) => doc.id).filter((id) => id !== uid);
  if (friendIds.length) {
    const friendId = friendIds[randomInt(0, friendIds.length - 1)];
    const friendDoc = await db.doc(`users/${friendId}`).get();
    if (friendDoc.exists) {
      const friend = normalizeProfile(friendId, friendDoc.data());
      return {
        id: friend.uid,
        nickname: friend.nickname,
        animal: friend.mainCharacter,
        rp: friend.rp,
        scoreTarget: Math.max(1000, Math.round(friend.bestScore * 0.86) + randomInt(-1400, 1800)),
        isBot: false,
      };
    }
  }
  return botOpponentFor(profile);
}

async function deleteDocumentRefs(refs: FirebaseFirestore.DocumentReference[]) {
  const uniqueRefs = refs.filter(
    (ref, index, list) => list.findIndex((item) => item.path === ref.path) === index,
  );
  for (let index = 0; index < uniqueRefs.length; index += 450) {
    const batch = db.batch();
    uniqueRefs.slice(index, index + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

async function assertRateLimit(uid: string, bucket: string, maxCount: number, windowMs: number) {
  const safeBucket = bucket.replace(/[^A-Za-z0-9_-]/g, "");
  const ref = db.doc(`rateLimits/${uid}_${safeBucket}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const raw = snapshot.data() || {};
    const windowStartedAt = clampInt(raw.windowStartedAt, 0, 0, now);
    const count = clampInt(raw.count, 0, 0, 999999);
    const expired = !snapshot.exists || now - windowStartedAt >= windowMs;
    const nextCount = expired ? 1 : count + 1;
    if (!expired && count >= maxCount) {
      throw new HttpsError("resource-exhausted", "요청이 너무 많아요. 잠시 후 다시 시도해주세요.");
    }
    tx.set(
      ref,
      {
        uid,
        bucket: safeBucket,
        windowStartedAt: expired ? now : windowStartedAt,
        count: nextCount,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

function assertNotBannedFromData(raw?: FirebaseFirestore.DocumentData) {
  if (raw?.active !== true) return;
  const expiresAt = timestampToMillis(raw.expiresAt);
  if (expiresAt && expiresAt <= Date.now()) return;
  const reason =
    typeof raw.reason === "string" && raw.reason ? raw.reason.slice(0, 80) : "계정 제한";
  throw new HttpsError("permission-denied", `현재 계정은 이용이 제한됐어요: ${reason}`);
}

async function assertNotBanned(uid: string) {
  const snapshot = await db.doc(`moderationBans/${uid}`).get();
  assertNotBannedFromData(snapshot.data());
}

async function assertNoBlockBetween(uid: string, targetUid: string) {
  const [selfBlock, targetBlock] = await Promise.all([
    db.doc(`userBlocks/${uid}/items/${targetUid}`).get(),
    db.doc(`userBlocks/${targetUid}/items/${uid}`).get(),
  ]);
  if (selfBlock.exists) {
    throw new HttpsError("failed-precondition", "차단한 유저와는 진행할 수 없어요.");
  }
  if (targetBlock.exists) {
    throw new HttpsError("permission-denied", "상대가 차단한 유저예요.");
  }
}

async function applyGuildContribution(
  tx: FirebaseFirestore.Transaction,
  uid: string,
  profile: PlayerProfile,
  score: number,
): Promise<GuildContribution | null> {
  const userGuildRef = db.doc(`userGuilds/${uid}`);
  const userGuildSnapshot = await tx.get(userGuildRef);
  const guildId = userGuildSnapshot.exists ? userGuildSnapshot.data()?.guildId : "";
  if (typeof guildId !== "string" || !guildId) return null;

  const guildRef = db.doc(`guilds/${guildId}`);
  const memberRef = db.doc(`guildMembers/${guildId}/items/${uid}`);
  const [guildSnapshot, memberSnapshot] = await Promise.all([tx.get(guildRef), tx.get(memberRef)]);
  if (!guildSnapshot.exists || !memberSnapshot.exists) return null;

  const guild = publicGuild(guildId, guildSnapshot.data());
  const damage = Math.max(1, Math.floor(clampInt(score, 0, 0, 9999999) / 100));
  const boss = {
    ...guild.boss,
    hp: Math.max(0, guild.boss.hp - damage),
  };
  tx.set(
    guildRef,
    {
      boss,
      weeklyScore: FieldValue.increment(damage),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  tx.set(
    memberRef,
    {
      nickname: profile.nickname,
      animal: profile.mainCharacter,
      weeklyContribution: FieldValue.increment(damage),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { guildId, damage, boss };
}

function progressLevelFromXp(xp: number) {
  return Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1;
}

function pickDailyMission(today = dayKey()) {
  const seed = [...today].reduce(
    (total, char, index) => total + char.charCodeAt(0) * (index + 3),
    0,
  );
  return dailyMissions[seed % dailyMissions.length];
}

function dailyMissionValue(mission: DailyMission, run: RunProgressPatch) {
  return missionRunValue(mission, run);
}

function missionRunValue(mission: { metric: DailyMissionMetric }, run: RunProgressPatch) {
  if (mission.metric === "score") return run.score;
  if (mission.metric === "maxCombo") return run.maxCombo;
  if (mission.metric === "feverCount") return run.feverCount;
  return run.specialTriggers;
}

function normalizeDailyMissionState(
  raw: FirebaseFirestore.DocumentData | undefined,
  mission: DailyMission,
  today = dayKey(),
): DailyMissionState {
  if (!raw || raw.dayKey !== today || raw.missionId !== mission.id) {
    return {
      dayKey: today,
      missionId: mission.id,
      progress: 0,
      claimed: false,
    };
  }

  return {
    dayKey: today,
    missionId: mission.id,
    progress: clampInt(raw.progress, 0, 0, 99999999),
    claimed: raw.claimed === true,
  };
}

function normalizeWeeklyMissionState(
  raw: FirebaseFirestore.DocumentData | undefined,
  currentWeek = weekKey(),
): WeeklyMissionState {
  const sameWeek = raw?.weekKey === currentWeek && raw.missions && typeof raw.missions === "object";
  const rawMissions = sameWeek ? (raw.missions as Record<string, unknown>) : {};
  const missions = Object.fromEntries(
    weeklyMissions.map((mission) => {
      const rawProgress = (rawMissions[mission.id] || {}) as Partial<WeeklyMissionProgress>;
      return [
        mission.id,
        {
          progress: clampInt(rawProgress.progress, 0, 0, 99999999),
          claimed: rawProgress.claimed === true,
        },
      ];
    }),
  ) as Record<string, WeeklyMissionProgress>;

  return { weekKey: currentWeek, missions };
}

function applyWeeklyMissionProgress(
  state: WeeklyMissionState,
  run: RunProgressPatch,
): WeeklyMissionState {
  const missions = { ...state.missions };
  weeklyMissions.forEach((mission) => {
    const current = missions[mission.id] || { progress: 0, claimed: false };
    const runValue = missionRunValue(mission, run);
    const progress =
      mission.aggregate === "sum"
        ? current.progress + runValue
        : Math.max(current.progress, runValue);
    missions[mission.id] = {
      ...current,
      progress: clampInt(progress, current.progress, 0, 99999999),
    };
  });
  return { ...state, missions };
}

function weeklyMissionDoc(state: WeeklyMissionState) {
  return {
    weekKey: state.weekKey,
    missions: Object.fromEntries(
      weeklyMissions.map((mission) => [
        mission.id,
        {
          progress: state.missions[mission.id]?.progress ?? 0,
          claimed: state.missions[mission.id]?.claimed === true,
        },
      ]),
    ),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function normalizeReplay(value: unknown): ReplayMove[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 240).map((move) => {
    const source = (move || {}) as Partial<ReplayMove>;
    const dir =
      source.dir === "up" ||
      source.dir === "down" ||
      source.dir === "left" ||
      source.dir === "right"
        ? source.dir
        : "up";
    return {
      r: clampInt(source.r, 0, 0, 6),
      c: clampInt(source.c, 0, 0, 6),
      dir,
      t: clampInt(source.t, 0, 0, 180000),
    };
  });
}

function validateReplayIntegrity(replay: ReplayMove[], durationMs: number) {
  let previousTime = -1;
  return replay.every((move) => {
    if (move.t < previousTime || move.t > durationMs + 2000) return false;
    previousTime = move.t;
    const targetR = move.r + (move.dir === "down" ? 1 : move.dir === "up" ? -1 : 0);
    const targetC = move.c + (move.dir === "right" ? 1 : move.dir === "left" ? -1 : 0);
    return targetR >= 0 && targetR <= 6 && targetC >= 0 && targetC <= 6;
  });
}

function validateRunPlausibility(
  run: RunProgressPatch,
  durationMs: number,
  replay: ReplayMove[],
  profile?: PlayerProfile,
) {
  if (run.score <= 0) return false;
  if (durationMs < 1000 || durationMs > 180000) return false;
  if (replay.length > 240) return false;
  if (run.matchedCells <= 0) return false;
  if (replay.length > 0 && !validateReplayIntegrity(replay, durationMs)) return false;
  if (run.maxCombo > Math.max(12, replay.length + 8, run.matchedCells)) return false;
  if (run.specialTriggers > Math.max(20, run.matchedCells + replay.length)) return false;
  if (run.feverCount > Math.max(6, Math.ceil(run.maxCombo / 5) + 4)) return false;

  const durationSeconds = Math.max(1, Math.ceil(durationMs / 1000));
  if (replay.length > Math.max(16, durationSeconds * 8 + 8)) return false;
  if (replay.length > 0 && run.matchedCells > replay.length * 18 + 60) return false;
  const scoreCap =
    run.matchedCells * 900 +
    run.maxCombo * 6000 +
    run.specialTriggers * 14000 +
    run.feverCount * 18000 +
    durationSeconds * 6000 +
    160000;
  const historyCap = profile
    ? Math.max(300000, profile.bestScore * 3 + 180000, profile.level * 75000 + 220000)
    : 9999999;
  return run.score <= Math.min(9999999, scoreCap, historyCap);
}

function buildDailyMissionStatus(state: DailyMissionState, mission: DailyMission) {
  return {
    dayKey: state.dayKey,
    mission,
    progress: Math.min(mission.goal, state.progress),
    claimed: state.claimed,
    completed: state.progress >= mission.goal,
    rewards: { stars: mission.rewardStars },
    resetAt: tomorrowKstIso(state.dayKey),
  };
}

function buildWeeklyMissionStatus(state: WeeklyMissionState) {
  return {
    weekKey: state.weekKey,
    missions: weeklyMissions.map((mission) => {
      const progress = state.missions[mission.id] || { progress: 0, claimed: false };
      return {
        mission,
        progress: Math.min(mission.goal, progress.progress),
        claimed: progress.claimed,
        completed: progress.claimed || progress.progress >= mission.goal,
        rewards: { stars: mission.rewardStars },
      };
    }),
    resetAt: nextWeekKstIso(),
  };
}

function buildDailyCheckinStatus(raw?: FirebaseFirestore.DocumentData) {
  const today = dayKey();
  const lastClaimedKey = typeof raw?.lastClaimedKey === "string" ? raw.lastClaimedKey : "";
  const claimedToday = lastClaimedKey === today;
  const previous = previousDayKey(today);
  const baseDay =
    lastClaimedKey === previous || claimedToday ? clampInt(raw?.cycleDay, 1, 1, 7) : 0;
  const currentDay = claimedToday ? Math.min(7, baseDay) : Math.min(7, baseDay + 1 || 1);
  const claimed = Array.isArray(raw?.claimed)
    ? raw.claimed.filter(
        (day: unknown): day is number =>
          typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7,
      )
    : [];
  return {
    currentDay,
    claimed,
    claimedToday,
    resetAt: tomorrowKstIso(today),
    rewards: checkinRewards,
  };
}

function normalizeStageProgress(raw?: FirebaseFirestore.DocumentData) {
  const source = (raw?.stars || {}) as Record<string, unknown>;
  const stars = Object.fromEntries(
    Object.entries(source)
      .filter(([stageId]) => /^(?:[1-9]|1[0-2])$/.test(stageId))
      .map(([stageId, value]) => [stageId, clampInt(value, 0, 0, 3)]),
  );
  return {
    chapter: typeof raw?.chapter === "string" ? raw.chapter : "ch1",
    currentStage: clampInt(raw?.currentStage, 1, 1, 12),
    stars,
  };
}

function buildCharacterDex(profile: PlayerProfile) {
  return characterDex.map((character) => ({
    ...character,
    unlocked: profile.unlockedCharacters.includes(character.animal),
    level: profile.characterLevels[character.animal] || 0,
    affinity: profile.characterAffinity[character.animal] || 0,
    plays: profile.characterPlays[character.animal] || 0,
  }));
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
  raw: FirebaseFirestore.DocumentData | undefined,
  seasonId: string,
): PassClaims {
  if (!raw || raw.seasonId !== seasonId) {
    return { seasonId, free: [], premium: [] };
  }
  return {
    seasonId,
    free: normalizePassClaimed(raw.free),
    premium: normalizePassClaimed(raw.premium),
  };
}

async function getCurrentSeason(): Promise<SeasonCurrent> {
  const snapshot = await db.doc("liveConfig/seasonCurrent").get();
  return snapshot.exists ? { ...fallbackSeason, ...snapshot.data() } : fallbackSeason;
}

function buildSeasonPassStatus(profile: PlayerProfile, claims: PassClaims, season: SeasonCurrent) {
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

function applyPassReward(profile: PlayerProfile, reward: PassReward): PlayerProfile {
  const inventory = { ...profile.inventory };
  for (const [key, value] of Object.entries(reward.inventory || {})) {
    const inventoryKey = key as keyof PlayerInventory;
    inventory[inventoryKey] = clampInt(
      (inventory[inventoryKey] || 0) + clampInt(value, 0, 0, 999),
      inventory[inventoryKey] || 0,
      0,
      999,
    );
  }

  const unlockedCharacters =
    reward.character && !profile.unlockedCharacters.includes(reward.character)
      ? [...profile.unlockedCharacters, reward.character]
      : profile.unlockedCharacters;
  const characterLevels =
    reward.character && !profile.characterLevels[reward.character]
      ? { ...profile.characterLevels, [reward.character]: 1 }
      : profile.characterLevels;
  const cosmetics =
    reward.cosmetic && !profile.cosmetics.includes(reward.cosmetic)
      ? [...profile.cosmetics, reward.cosmetic]
      : profile.cosmetics;

  return {
    ...profile,
    hearts: Math.min(MAX_HEARTS, profile.hearts + clampInt(reward.hearts, 0, 0, 999)),
    stars: clampInt(profile.stars + clampInt(reward.stars, 0, 0, 999999), profile.stars),
    coins: clampInt(
      profile.coins + clampInt(reward.coins, 0, 0, 999999),
      profile.coins,
      0,
      9999999,
    ),
    inventory,
    unlockedCharacters,
    characterLevels,
    cosmetics,
  };
}

function publicProfile(profile: PlayerProfile) {
  return profile;
}

function profileDoc(profile: PlayerProfile) {
  const { uid: _uid, authMode: _authMode, ...document } = profile;
  return document;
}

function maxRunReward(run: RunProgressPatch, missionRewardStars = 0) {
  const score = clampInt(run.score, 0, 0, 9999999);
  const maxCombo = clampInt(run.maxCombo, 0, 0, 999);
  const specialTriggers = clampInt(run.specialTriggers, 0, 0, 99999);
  const feverCount = clampInt(run.feverCount, 0, 0, 999);
  const xp = Math.max(
    20,
    Math.floor(score / 500) + maxCombo * 8 + specialTriggers * 12 + feverCount * 20 + 40,
  );
  const stars =
    score > 0
      ? Math.max(5, Math.floor(score / 2500) + specialTriggers * 2) + missionRewardStars
      : 0;
  return { xp, stars };
}

function normalizeProgressPatch(
  profile: PlayerProfile,
  run: RunProgressPatch,
  missionClaimed: boolean,
  missionRewardStars: number,
) {
  const today = dayKey();
  const currentCompletedDailyKeys = profile.completedDailyKeys
    .filter((key): key is string => typeof key === "string")
    .slice(-31);
  const dailyCompleted = missionClaimed && !currentCompletedDailyKeys.includes(today);
  const reward = maxRunReward(run, missionClaimed ? missionRewardStars : 0);
  const xp = clampInt(profile.xp + reward.xp, profile.xp, profile.xp, 99999999);
  const completedDailyKeys = dailyCompleted
    ? [...new Set([...currentCompletedDailyKeys, today])].sort().slice(-31)
    : currentCompletedDailyKeys;
  const streak = dailyCompleted
    ? profile.lastDailyKey === previousDayKey(today)
      ? profile.streak + 1
      : 1
    : profile.streak;
  return {
    level: progressLevelFromXp(xp),
    xp,
    stars: clampInt(profile.stars + reward.stars, profile.stars, profile.stars, 99999999),
    streak,
    lastDailyKey: dailyCompleted ? today : profile.lastDailyKey,
    completedDailyKeys,
    rewards: reward,
  };
}

async function getShopItem(itemId: string) {
  const snapshot = await db.doc("liveConfig/shopItems").get();
  const items =
    snapshot.exists && Array.isArray(snapshot.data()?.items)
      ? (snapshot.data()?.items as ShopItem[])
      : fallbackShopItems;
  return items.find((item) => item.id === itemId) || null;
}

async function getIapShopItem(productId: string) {
  const snapshot = await db.doc("liveConfig/shopItems").get();
  const items =
    snapshot.exists && Array.isArray(snapshot.data()?.items)
      ? (snapshot.data()?.items as ShopItem[])
      : fallbackShopItems;
  return items.find((item) => item.currency === "iap" && item.productId === productId) || null;
}

function applyIapGrant(profile: PlayerProfile, grant: IapGrant, quantity: number) {
  const multiplier = Math.max(1, Math.min(99, quantity));
  const inventory = { ...profile.inventory };
  const vipDays = clampInt(grant.vipDays, 0, 0, 365) * multiplier;
  const vipBase = Math.max(profile.vipUntil, Date.now());
  for (const [key, value] of Object.entries(grant.inventory || {})) {
    const inventoryKey = key as keyof PlayerInventory;
    inventory[inventoryKey] = clampInt(
      inventory[inventoryKey] + clampInt(value, 0, 0, 999) * multiplier,
      inventory[inventoryKey],
      0,
      999,
    );
  }

  return {
    ...profile,
    hearts: Math.min(MAX_HEARTS, profile.hearts + clampInt(grant.hearts, 0, 0, 999) * multiplier),
    stars: profile.stars + clampInt(grant.stars, 0, 0, 999999) * multiplier,
    coins: profile.coins + clampInt(grant.coins, 0, 0, 999999) * multiplier,
    inventory,
    seasonPassPremium: profile.seasonPassPremium || grant.seasonPassPremium === true,
    vipUntil: vipDays > 0 ? vipBase + vipDays * 86400000 : profile.vipUntil,
  };
}

function summarizeIapGrant(grant: IapGrant, quantity: number) {
  const multiplier = Math.max(1, Math.min(99, quantity));
  return {
    hearts: clampInt(grant.hearts, 0, 0, 999) * multiplier,
    stars: clampInt(grant.stars, 0, 0, 999999) * multiplier,
    coins: clampInt(grant.coins, 0, 0, 999999) * multiplier,
    inventory: grant.inventory || {},
    seasonPassPremium: grant.seasonPassPremium === true,
    vipDays: clampInt(grant.vipDays, 0, 0, 365) * multiplier,
  };
}

async function verifyAndroidIap(
  productId: string,
  purchaseToken: unknown,
): Promise<VerifiedIapPurchase> {
  if (typeof purchaseToken !== "string" || purchaseToken.length < 16) {
    throw new HttpsError("invalid-argument", "Android 구매 토큰이 필요해요.");
  }

  const packageName = readEnv("GOOGLE_PLAY_PACKAGE_NAME");
  if (!packageName) {
    throw new HttpsError("failed-precondition", "Google Play 패키지명이 설정되지 않았어요.");
  }

  const googleAuth = new GoogleAuth({ scopes: [GOOGLE_ANDROID_PUBLISHER_SCOPE] });
  const client = await googleAuth.getClient();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    packageName,
  )}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(
    purchaseToken,
  )}`;
  let response: { data: Record<string, unknown> };
  try {
    response = await client.request<Record<string, unknown>>({ method: "GET", url });
  } catch {
    throw new HttpsError("unavailable", "Google Play 구매 검증에 실패했어요.");
  }
  const purchase = response.data;
  const purchaseState = clampInt(purchase.purchaseState, -1, -1, 9);

  if (purchaseState !== 0) {
    throw new HttpsError("failed-precondition", "완료된 Google Play 구매가 아니에요.");
  }
  if (typeof purchase.productId === "string" && purchase.productId !== productId) {
    throw new HttpsError("permission-denied", "구매 상품 ID가 일치하지 않아요.");
  }

  const orderId = typeof purchase.orderId === "string" ? purchase.orderId : "";
  const quantity = clampInt(purchase.quantity, 1, 1, 99);
  return {
    platform: "android" as const,
    productId,
    transactionId: orderId || sha256(purchaseToken),
    quantity,
    environment: "production" as const,
    orderId: orderId || undefined,
    tokenHash: sha256(purchaseToken),
  };
}

function createAppleServerJwt() {
  const issuerId = readEnv("APPLE_IAP_ISSUER_ID");
  const keyId = readEnv("APPLE_IAP_KEY_ID");
  const bundleId = readEnv("APPLE_IAP_BUNDLE_ID");
  const privateKeyRaw = readEnv("APPLE_IAP_PRIVATE_KEY");

  if (!issuerId || !keyId || !bundleId || !privateKeyRaw) {
    throw new HttpsError("failed-precondition", "App Store Server API 키가 설정되지 않았어요.");
  }

  const now = Math.floor(Date.now() / 1000);
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const header = base64UrlJson({ alg: "ES256", kid: keyId, typ: "JWT" });
  const payload = base64UrlJson({
    iss: issuerId,
    iat: now,
    exp: now + 300,
    aud: "appstoreconnect-v1",
    bid: bundleId,
  });
  try {
    const signingInput = `${header}.${payload}`;
    const signature = signCrypto("sha256", Buffer.from(signingInput), {
      key: createPrivateKey(privateKey),
      dsaEncoding: "ieee-p1363",
    });
    return `${signingInput}.${signature.toString("base64url")}`;
  } catch {
    throw new HttpsError("failed-precondition", "App Store Server API 키 형식이 올바르지 않아요.");
  }
}

async function requestAppleTransaction(
  transactionId: string,
  environment: "production" | "sandbox",
) {
  const host =
    environment === "sandbox"
      ? "https://api.storekit-sandbox.apple.com"
      : "https://api.storekit.apple.com";
  let response: Response;
  try {
    response = await fetch(`${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${createAppleServerJwt()}`,
      },
    });
  } catch {
    throw new HttpsError("unavailable", "App Store 구매 검증에 실패했어요.");
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new HttpsError(
      response.status === 401 ? "failed-precondition" : "unavailable",
      "App Store 구매 검증에 실패했어요.",
    );
  }

  return (await response.json()) as { signedTransactionInfo?: string };
}

async function verifyAppleIap(
  productId: string,
  transactionId: unknown,
): Promise<VerifiedIapPurchase> {
  if (typeof transactionId !== "string" || transactionId.length < 6) {
    throw new HttpsError("invalid-argument", "App Store transactionId가 필요해요.");
  }

  const preferredEnv = readEnv("APPLE_IAP_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
  const first = await requestAppleTransaction(transactionId, preferredEnv);
  const response =
    first ||
    (preferredEnv === "production"
      ? await requestAppleTransaction(transactionId, "sandbox")
      : await requestAppleTransaction(transactionId, "production"));
  if (!response?.signedTransactionInfo) {
    throw new HttpsError("not-found", "App Store 거래를 찾을 수 없어요.");
  }

  const [, payloadPart] = response.signedTransactionInfo.split(".");
  if (!payloadPart) throw new HttpsError("data-loss", "App Store 거래 응답이 올바르지 않아요.");
  const payload = decodeBase64UrlJson(payloadPart);
  const bundleId = readEnv("APPLE_IAP_BUNDLE_ID");

  if (payload.productId !== productId) {
    throw new HttpsError("permission-denied", "구매 상품 ID가 일치하지 않아요.");
  }
  if (bundleId && payload.bundleId !== bundleId) {
    throw new HttpsError("permission-denied", "앱 번들 ID가 일치하지 않아요.");
  }
  if ("revocationDate" in payload) {
    throw new HttpsError("failed-precondition", "환불 또는 취소된 App Store 거래예요.");
  }

  const environment: VerifiedIapPurchase["environment"] =
    payload.environment === "Sandbox"
      ? "sandbox"
      : payload.environment === "Production"
        ? "production"
        : "unknown";

  return {
    platform: "ios" as const,
    productId,
    transactionId:
      typeof payload.transactionId === "string" ? payload.transactionId : transactionId,
    quantity: clampInt(payload.quantity, 1, 1, 99),
    environment,
  };
}

async function verifyIapWithStore(data: {
  platform: IapPlatform;
  productId: string;
  purchaseToken?: unknown;
  transactionId?: unknown;
}) {
  if (data.platform === "android") {
    return verifyAndroidIap(data.productId, data.purchaseToken);
  }
  return verifyAppleIap(data.productId, data.transactionId);
}

async function runUserTransaction<T>(
  uid: string,
  update: (
    profile: PlayerProfile,
    userRef: FirebaseFirestore.DocumentReference,
    tx: FirebaseFirestore.Transaction,
    exists: boolean,
  ) => Promise<T> | T,
) {
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const banRef = db.doc(`moderationBans/${uid}`);
    const [snapshot, banSnapshot] = await Promise.all([tx.get(userRef), tx.get(banRef)]);
    assertNotBannedFromData(banSnapshot.data());
    const profile = recoverHearts(
      normalizeProfile(uid, snapshot.exists ? snapshot.data() : undefined),
    );
    return update(profile, userRef, tx, snapshot.exists);
  });
}

async function upsertAuthProfile(
  uid: string,
  input: {
    nickname?: unknown;
    providerPatch?: Pick<PlayerProfile, "authProvider" | "linkedProviders">;
  } = {},
) {
  const userRef = db.doc(`users/${uid}`);
  const accountPatch = input.providerPatch || (await getAccountProviderPatch(uid));
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(userRef);
    const profile = recoverHearts(
      normalizeProfile(uid, snapshot.exists ? snapshot.data() : undefined),
    );
    const nextProfile = {
      ...profile,
      nickname: sanitizeNickname(input.nickname || profile.nickname),
      ...accountPatch,
    };
    tx.set(
      userRef,
      {
        ...profileDoc(nextProfile),
        ...(snapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
        lastLoginAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return publicProfile(nextProfile);
  });
}

async function issueAuthSession(uid: string, profile?: PlayerProfile) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const jti = randomBytes(16).toString("base64url");
  const accessToken = signSessionJwt({
    sub: uid,
    typ: "access",
    jti,
    iat: nowSeconds,
    exp: nowSeconds + Math.floor(JWT_ACCESS_TTL_MS / 1000),
  });
  const refreshToken = `rt_${randomBytes(32).toString("base64url")}`;
  const refreshTokenHash = sha256(refreshToken);
  const expiresAtMs = Date.now() + REFRESH_TOKEN_TTL_MS;
  await db.doc(`authRefreshTokens/${refreshTokenHash}`).set({
    uid,
    refreshTokenHash,
    accessJti: jti,
    revoked: false,
    expiresAtMs,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const user = profile || (await upsertAuthProfile(uid));
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(JWT_ACCESS_TTL_MS / 1000),
    refreshExpiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
    user,
  };
}

async function rotateAuthRefreshToken(refreshToken: unknown) {
  if (typeof refreshToken !== "string" || !refreshToken.startsWith("rt_")) {
    throw new HttpsError("invalid-argument", "refreshToken이 필요해요.");
  }
  const refreshTokenHash = sha256(refreshToken);
  const refreshRef = db.doc(`authRefreshTokens/${refreshTokenHash}`);
  const uid = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(refreshRef);
    const raw = snapshot.data() || {};
    if (!snapshot.exists || typeof raw.uid !== "string") {
      throw new HttpsError("unauthenticated", "refreshToken을 찾을 수 없어요.");
    }
    if (raw.revoked === true) {
      throw new HttpsError("unauthenticated", "이미 사용된 refreshToken이에요.");
    }
    if (clampInt(raw.expiresAtMs, 0, 0, Number.MAX_SAFE_INTEGER) <= Date.now()) {
      throw new HttpsError("unauthenticated", "refreshToken이 만료됐어요.");
    }
    tx.set(
      refreshRef,
      {
        revoked: true,
        rotatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return raw.uid as string;
  });
  return issueAuthSession(uid);
}

async function authUidFromRestRequest(request: { headers: { authorization?: string | string[] } }) {
  return verifySessionJwt(bearerToken(request.headers.authorization)).sub;
}

async function loginRestAuth(data: Record<string, unknown>) {
  const provider = sanitizeAuthProviderKey(data.provider);
  if (provider === "guest" || provider === "anonymous") {
    if (typeof data.idToken === "string" && data.idToken) {
      const decoded = await auth.verifyIdToken(data.idToken);
      const profile = await upsertAuthProfile(decoded.uid, {
        nickname: data.nickname,
        providerPatch: { authProvider: "anonymous", linkedProviders: ["anonymous"] },
      });
      return issueAuthSession(decoded.uid, profile);
    }
    const user = await auth.createUser({ displayName: sanitizeNickname(data.nickname) });
    const profile = await upsertAuthProfile(user.uid, {
      nickname: data.nickname,
      providerPatch: { authProvider: "anonymous", linkedProviders: ["anonymous"] },
    });
    return issueAuthSession(user.uid, profile);
  }

  if (typeof data.idToken !== "string" || !data.idToken) {
    throw new HttpsError("invalid-argument", "소셜 idToken이 필요해요.");
  }
  const decoded = await auth.verifyIdToken(data.idToken);
  const providerPatch = await getAccountProviderPatch(decoded.uid);
  if (!providerPatch.linkedProviders.includes(provider)) {
    throw new HttpsError("permission-denied", "요청한 소셜 제공자와 토큰이 일치하지 않아요.");
  }
  const profile = await upsertAuthProfile(decoded.uid, {
    nickname: data.nickname,
    providerPatch,
  });
  return issueAuthSession(decoded.uid, profile);
}

async function linkRestAuth(uid: string, data: Record<string, unknown>) {
  const provider = sanitizeAuthProviderKey(data.provider);
  if (provider === "guest" || provider === "anonymous") {
    throw new HttpsError("invalid-argument", "소셜 제공자를 선택해주세요.");
  }
  if (typeof data.idToken !== "string" || !data.idToken) {
    throw new HttpsError("invalid-argument", "소셜 idToken이 필요해요.");
  }
  const decoded = await auth.verifyIdToken(data.idToken);
  const providerPatch = await getAccountProviderPatch(decoded.uid);
  if (!providerPatch.linkedProviders.includes(provider)) {
    throw new HttpsError("permission-denied", "요청한 소셜 제공자와 토큰이 일치하지 않아요.");
  }

  if (decoded.uid !== uid) {
    await db.runTransaction(async (tx) => {
      const sourceRef = db.doc(`users/${uid}`);
      const targetRef = db.doc(`users/${decoded.uid}`);
      const [sourceSnapshot, targetSnapshot] = await Promise.all([
        tx.get(sourceRef),
        tx.get(targetRef),
      ]);
      const sourceProfile = recoverHearts(
        normalizeProfile(uid, sourceSnapshot.exists ? sourceSnapshot.data() : undefined),
      );
      const targetProfile = recoverHearts(
        normalizeProfile(decoded.uid, targetSnapshot.exists ? targetSnapshot.data() : undefined),
      );
      const nextProfile = {
        ...sourceProfile,
        uid: decoded.uid,
        bestScore: Math.max(sourceProfile.bestScore, targetProfile.bestScore),
        totalScore: Math.max(sourceProfile.totalScore, targetProfile.totalScore),
        stars: Math.max(sourceProfile.stars, targetProfile.stars),
        coins: Math.max(sourceProfile.coins, targetProfile.coins),
        ...providerPatch,
      };
      tx.set(
        targetRef,
        {
          ...profileDoc(nextProfile),
          ...(targetSnapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
          migratedFrom: uid,
          lastLoginAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.set(
        sourceRef,
        {
          migratedTo: decoded.uid,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  const profile = await upsertAuthProfile(decoded.uid, { providerPatch });
  return issueAuthSession(decoded.uid, profile);
}

async function restoreRestAuth(uid: string, codeValue: unknown) {
  const code = sanitizeRestoreCode(codeValue);
  const accountPatch = await getAccountProviderPatch(uid);
  const profile = await db.runTransaction(async (tx) => {
    const restoreRef = db.doc(`restoreCodes/${code}`);
    const restoreSnapshot = await tx.get(restoreRef);
    if (!restoreSnapshot.exists) {
      throw new HttpsError("not-found", "복원 코드를 찾을 수 없어요.");
    }
    const restoreDoc = restoreSnapshot.data() || {};
    if (restoreDoc.consumed === true) {
      throw new HttpsError("failed-precondition", "이미 사용된 복원 코드예요.");
    }
    if (clampInt(restoreDoc.expiresAtMs, 0, 0, Number.MAX_SAFE_INTEGER) <= Date.now()) {
      throw new HttpsError("deadline-exceeded", "복원 코드가 만료됐어요.");
    }
    const sourceUid = typeof restoreDoc.sourceUid === "string" ? restoreDoc.sourceUid : "";
    if (!sourceUid) throw new HttpsError("failed-precondition", "복원 코드가 올바르지 않아요.");
    const sourceSnapshot = await tx.get(db.doc(`users/${sourceUid}`));
    if (!sourceSnapshot.exists) {
      throw new HttpsError("not-found", "복원할 프로필을 찾을 수 없어요.");
    }
    const sourceProfile = recoverHearts(normalizeProfile(sourceUid, sourceSnapshot.data()));
    const nextProfile = { ...sourceProfile, uid, ...accountPatch };
    tx.set(
      db.doc(`users/${uid}`),
      {
        ...profileDoc(nextProfile),
        lastLoginAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(
      restoreRef,
      {
        consumed: true,
        consumedBy: uid,
        consumedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return publicProfile(nextProfile);
  });
  return issueAuthSession(uid, profile);
}

function runProgressFromRestData(data: Record<string, unknown>): RunProgressPatch {
  return {
    matchId: typeof data.matchId === "string" ? data.matchId : undefined,
    score: clampInt(data.score, 0, 0, 9999999),
    matchedCells: clampInt(data.matchedCells ?? data.matches, 0, 0, 99999),
    maxCombo: clampInt(data.maxCombo, 0, 0, 999),
    specialTriggers: clampInt(data.specialTriggers ?? data.specials, 0, 0, 99999),
    feverCount: clampInt(data.feverCount, 0, 0, 999),
  };
}

async function getPlayerStatsForUid(uid: string) {
  const userSnapshot = await db.doc(`users/${uid}`).get();
  const profile = recoverHearts(
    normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
  );
  return {
    profile: publicProfile(profile),
    stats: buildPlayerStats(profile),
  };
}

async function updatePlayerProfileForUid(uid: string, data: Record<string, unknown>) {
  const accountPatch = await getAccountProviderPatch(uid);
  return runUserTransaction(uid, (profile, userRef, tx, exists) => {
    const nextMainCharacter = isCharacterId(data.mainCharacter)
      ? data.mainCharacter
      : profile.mainCharacter;
    if (!profile.unlockedCharacters.includes(nextMainCharacter)) {
      throw new HttpsError("failed-precondition", "아직 잠긴 캐릭터예요.");
    }
    const nextProfile = {
      ...profile,
      nickname: sanitizeNickname(data.nickname || profile.nickname),
      mainCharacter: nextMainCharacter,
      ...accountPatch,
    };
    tx.set(
      userRef,
      {
        ...profileDoc(nextProfile),
        ...(exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
        lastLoginAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile), user: publicProfile(nextProfile) };
  });
}

async function consumeHeartForUid(uid: string) {
  return runUserTransaction(uid, (profile, userRef, tx) => {
    if (profile.hearts <= 0) {
      tx.set(
        userRef,
        { ...profileDoc(profile), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return { spent: false, profile: publicProfile(profile) };
    }
    const nextProfile = {
      ...profile,
      hearts: profile.hearts - 1,
      lastHeartAt: profile.hearts >= MAX_HEARTS ? Date.now() : profile.lastHeartAt,
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { spent: true, profile: publicProfile(nextProfile) };
  });
}

async function refillHeartForUid(uid: string) {
  return runUserTransaction(uid, (profile, userRef, tx) => {
    const hearts = Math.min(MAX_HEARTS, profile.hearts + 1);
    const nextProfile = {
      ...profile,
      hearts,
      lastHeartAt: hearts >= MAX_HEARTS ? Date.now() : profile.lastHeartAt,
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile) };
  });
}

async function claimHeartTimerForUid(uid: string) {
  return runUserTransaction(uid, (profile, userRef, tx) => {
    const nextProfile = recoverHearts(profile);
    const claimed = Math.max(0, nextProfile.hearts - profile.hearts);
    if (claimed > 0 || nextProfile.lastHeartAt !== profile.lastHeartAt) {
      tx.set(
        userRef,
        { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    return {
      claimed,
      nextHeartAt: getNextHeartAt(nextProfile),
      profile: publicProfile(nextProfile),
    };
  });
}

async function createMatchSessionForUid(uid: string, data: Record<string, unknown>) {
  await assertRateLimit(uid, "match_start", 30, 60 * 1000);
  await assertNotBanned(uid);
  const mode = isMatchMode(data.mode) ? data.mode : "rush";
  const matchId = sanitizeMatchId(data.matchId, uid);
  const seed = createServerMatchSeed(uid, matchId);
  const startedAtMs = Date.now();
  const matchRef = db.doc(`matches/${matchId}`);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(matchRef);
    if (snapshot.exists) {
      throw new HttpsError("already-exists", "이미 사용 중인 매치 ID예요.");
    }
    tx.set(matchRef, {
      userId: uid,
      mode,
      seed,
      status: "started",
      startedAtMs,
      accepted: false,
      rewardsClaimed: false,
      scoreSubmitted: false,
      version: "0.3.0",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { matchId, mode, seed, startedAtMs, startedAt: startedAtMs, savedOnline: true };
}

async function finishMatchForUid(uid: string, data: Record<string, unknown>) {
  await assertNotBanned(uid);
  const run = runProgressFromRestData(data);
  if (!run.matchId) throw new HttpsError("invalid-argument", "matchId가 필요해요.");
  const replay = normalizeReplay(data.replay);
  const matchRef = db.doc(`matches/${run.matchId}`);

  return db.runTransaction(async (tx) => {
    const [snapshot, userSnapshot] = await Promise.all([
      tx.get(matchRef),
      tx.get(db.doc(`users/${uid}`)),
    ]);
    if (!snapshot.exists) throw new HttpsError("not-found", "매치 세션을 찾을 수 없어요.");
    const match = snapshot.data() || {};
    if (match.userId !== uid) throw new HttpsError("permission-denied", "다른 계정의 매치예요.");
    if (match.status === "finished") {
      return {
        accepted: match.accepted === true,
        savedOnline: true,
        alreadyFinished: true,
        run: {
          matchId: run.matchId,
          score: clampInt(match.score, run.score, 0, 9999999),
          matchedCells: clampInt(match.matchedCells, run.matchedCells, 0, 99999),
          maxCombo: clampInt(match.maxCombo, run.maxCombo, 0, 999),
          specialTriggers: clampInt(match.specialTriggers, run.specialTriggers, 0, 99999),
          feverCount: clampInt(match.feverCount, run.feverCount, 0, 999),
        },
      };
    }
    if (match.status !== "started") {
      throw new HttpsError("failed-precondition", "시작된 매치가 아니에요.");
    }
    if (typeof data.seed !== "string" || data.seed !== match.seed) {
      throw new HttpsError("permission-denied", "매치 시드가 일치하지 않아요.");
    }
    const startedAtMs = clampInt(match.startedAtMs, 0, 0, Date.now());
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const accepted = validateRunPlausibility(run, durationMs, replay, profile);
    const rewards = {
      xp: clampInt((data.rewards as { xp?: unknown } | undefined)?.xp, 0, 0, 99999999),
      stars: clampInt((data.rewards as { stars?: unknown } | undefined)?.stars, 0, 0, 99999999),
    };
    tx.set(
      matchRef,
      {
        mode: isMatchMode(data.mode) ? data.mode : match.mode || "rush",
        status: "finished",
        durationMs,
        score: run.score,
        maxCombo: run.maxCombo,
        matchedCells: run.matchedCells,
        specialTriggers: run.specialTriggers,
        feverCount: run.feverCount,
        rewards,
        replay,
        moveCount: replay.length,
        accepted,
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { accepted, savedOnline: true, alreadyFinished: false, run };
  });
}

async function grantRunProgressForUid(uid: string, run: RunProgressPatch) {
  if (run.score <= 0) throw new HttpsError("failed-precondition", "점수가 있는 기록만 저장돼요.");
  if (!run.matchId) throw new HttpsError("invalid-argument", "matchId가 필요해요.");

  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const matchRef = db.doc(`matches/${run.matchId}`);
    const matchSnapshot = await tx.get(matchRef);
    if (!matchSnapshot.exists) throw new HttpsError("not-found", "매치 세션을 찾을 수 없어요.");
    const match = matchSnapshot.data() || {};
    if (match.userId !== uid) throw new HttpsError("permission-denied", "다른 계정의 매치예요.");
    if (match.status !== "finished" || match.accepted !== true) {
      throw new HttpsError("failed-precondition", "검증된 매치만 보상을 받을 수 있어요.");
    }
    if (match.rewardsClaimed === true) {
      throw new HttpsError("already-exists", "이미 보상이 지급된 매치예요.");
    }
    if (
      clampInt(match.score, 0, 0, 9999999) !== run.score ||
      clampInt(match.maxCombo, 0, 0, 999) !== run.maxCombo ||
      clampInt(match.matchedCells, 0, 0, 99999) !== run.matchedCells ||
      clampInt(match.specialTriggers, 0, 0, 99999) !== run.specialTriggers ||
      clampInt(match.feverCount, 0, 0, 999) !== run.feverCount
    ) {
      throw new HttpsError("permission-denied", "매치 결과가 세션 기록과 일치하지 않아요.");
    }

    const today = dayKey();
    const currentWeek = weekKey();
    const mission = pickDailyMission(today);
    const missionRef = db.doc(`dailyMissions/${uid}`);
    const weeklyMissionRef = db.doc(`weeklyMissions/${uid}`);
    const [missionSnapshot, weeklyMissionSnapshot] = await Promise.all([
      tx.get(missionRef),
      tx.get(weeklyMissionRef),
    ]);
    const missionState = normalizeDailyMissionState(missionSnapshot.data(), mission, today);
    const weeklyMissionState = normalizeWeeklyMissionState(
      weeklyMissionSnapshot.data(),
      currentWeek,
    );
    const alreadyCompletedToday = profile.completedDailyKeys.includes(today);
    const missionProgress = Math.max(missionState.progress, dailyMissionValue(mission, run));
    const missionClaimed =
      !missionState.claimed && !alreadyCompletedToday && missionProgress >= mission.goal;
    const nextMissionState = {
      ...missionState,
      progress: missionProgress,
      claimed: missionState.claimed || alreadyCompletedToday || missionClaimed,
    };
    const nextWeeklyMissionState = applyWeeklyMissionProgress(weeklyMissionState, run);
    const progress = normalizeProgressPatch(profile, run, missionClaimed, mission.rewardStars);
    const mainCharacter = profile.mainCharacter;
    const characterPlays = {
      ...profile.characterPlays,
      [mainCharacter]: (profile.characterPlays[mainCharacter] || 0) + 1,
    };
    const characterAffinity = {
      ...profile.characterAffinity,
      [mainCharacter]:
        (profile.characterAffinity[mainCharacter] || 0) + Math.max(1, Math.floor(run.score / 5000)),
    };
    const nextProfile = {
      ...profile,
      level: progress.level,
      xp: progress.xp,
      stars: progress.stars,
      streak: progress.streak,
      lastDailyKey: progress.lastDailyKey,
      completedDailyKeys: progress.completedDailyKeys,
      bestScore: Math.max(profile.bestScore, run.score),
      totalScore: profile.totalScore + run.score,
      totalPlays: profile.totalPlays + 1,
      totalMatches: profile.totalMatches + run.matchedCells,
      maxCombo: Math.max(profile.maxCombo, run.maxCombo),
      totalSpecials: profile.totalSpecials + run.specialTriggers,
      characterAffinity,
      characterPlays,
    };
    const guildContribution = await applyGuildContribution(tx, uid, nextProfile, run.score);
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      matchRef,
      {
        rewardsClaimed: true,
        guildClaimed: guildContribution ? true : FieldValue.delete(),
        guildDamage: guildContribution?.damage ?? FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    const missionDoc: Record<string, unknown> = {
      ...nextMissionState,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (missionClaimed) missionDoc.claimedAt = FieldValue.serverTimestamp();
    else if (!missionState.claimed) missionDoc.claimedAt = null;
    tx.set(missionRef, missionDoc, { merge: true });
    tx.set(weeklyMissionRef, weeklyMissionDoc(nextWeeklyMissionState), { merge: true });
    return {
      profile: publicProfile(nextProfile),
      rewards: {
        ...progress.rewards,
        missionStars: missionClaimed ? mission.rewardStars : 0,
      },
      mission: buildDailyMissionStatus(nextMissionState, mission),
      weeklyMissions: buildWeeklyMissionStatus(nextWeeklyMissionState),
      guildContribution,
    };
  });
}

async function submitLeaderboardForUid(uid: string, runId: string, nicknameValue?: unknown) {
  if (typeof runId !== "string") {
    throw new HttpsError("invalid-argument", "runId가 필요해요.");
  }
  const matchRef = db.doc(`matches/${runId}`);
  const scoreRef = db.doc(`scores/${runId}`);
  return db.runTransaction(async (tx) => {
    const [matchSnapshot, scoreSnapshot] = await Promise.all([tx.get(matchRef), tx.get(scoreRef)]);
    if (!matchSnapshot.exists) throw new HttpsError("not-found", "매치 세션을 찾을 수 없어요.");
    const match = matchSnapshot.data() || {};
    if (match.userId !== uid) throw new HttpsError("permission-denied", "다른 계정의 기록이에요.");
    if (match.status !== "finished" || match.accepted !== true) {
      throw new HttpsError("failed-precondition", "검증된 매치만 랭킹에 등록돼요.");
    }
    const nickname = sanitizeNickname(nicknameValue);
    const score = clampInt(match.score, 0, 1, 9999999);
    const entry = {
      nickname,
      playerUid: uid,
      score,
      maxCombo: clampInt(match.maxCombo, 0, 0, 999),
      feverCount: clampInt(match.feverCount, 0, 0, 999),
      mode: "60s",
      version: "0.3.0",
      playedAtDay: dayKey(),
      playedAtWeek: weekKey(),
    };
    if (!scoreSnapshot.exists) {
      tx.set(scoreRef, { ...entry, createdAt: FieldValue.serverTimestamp() });
      tx.set(
        matchRef,
        { scoreSubmitted: true, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    return { id: runId, ...entry, savedOnline: true };
  });
}

async function finishMatchRestForUid(uid: string, data: Record<string, unknown>) {
  const finish = await finishMatchForUid(uid, data);
  if (!finish.accepted || finish.alreadyFinished) return finish;
  const progress = await grantRunProgressForUid(uid, finish.run);
  const ranking = await submitLeaderboardForUid(
    uid,
    finish.run.matchId || "",
    progress.profile.nickname,
  );
  return {
    accepted: finish.accepted,
    savedOnline: finish.savedOnline,
    rewards: progress.rewards,
    newBest: progress.profile.bestScore === finish.run.score,
    profile: progress.profile,
    mission: progress.mission,
    weeklyMissions: progress.weeklyMissions,
    guildContribution: progress.guildContribution,
    ranking,
  };
}

async function getShopItemsForRest() {
  const snapshot = await db.doc("liveConfig/shopItems").get();
  const items =
    snapshot.exists && Array.isArray(snapshot.data()?.items)
      ? (snapshot.data()?.items as ShopItem[]).slice(0, 60)
      : fallbackShopItems;
  return { items };
}

async function verifyIapPurchaseForUid(uid: string, data: Record<string, unknown>) {
  if (!isIapPlatform(data.platform)) {
    throw new HttpsError("invalid-argument", "스토어 플랫폼이 올바르지 않아요.");
  }
  if (typeof data.productId !== "string" || data.productId.length > 120) {
    throw new HttpsError("invalid-argument", "상품 ID가 필요해요.");
  }
  const item = await getIapShopItem(data.productId);
  const grant = iapGrants[data.productId];
  if (!item || !grant) {
    throw new HttpsError("not-found", "검증 가능한 결제 상품이 아니에요.");
  }
  const verified = await verifyIapWithStore({
    platform: data.platform,
    productId: data.productId,
    purchaseToken: data.purchaseToken || data.receipt,
    transactionId: data.transactionId || data.receipt,
  });
  const transactionRef = db.doc(
    `iapTransactions/${verified.platform}_${sha256(verified.transactionId)}`,
  );

  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const [userSnapshot, transactionSnapshot] = await Promise.all([
      tx.get(userRef),
      tx.get(transactionRef),
    ]);
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const rewards = summarizeIapGrant(grant, verified.quantity);
    if (transactionSnapshot.exists) {
      const existing = transactionSnapshot.data();
      if (existing?.userId !== uid) {
        throw new HttpsError("already-exists", "이미 다른 계정에 지급된 결제예요.");
      }
      return {
        profile: publicProfile(profile),
        granted: false,
        alreadyGranted: true,
        item,
        rewards,
      };
    }
    const nextProfile = applyIapGrant(profile, grant, verified.quantity);
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(transactionRef, {
      userId: uid,
      platform: verified.platform,
      productId: verified.productId,
      itemId: item.id,
      transactionId: verified.transactionId,
      orderId: verified.orderId || null,
      tokenHash: verified.tokenHash || null,
      quantity: verified.quantity,
      environment: verified.environment,
      rewards,
      grantedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      profile: publicProfile(nextProfile),
      granted: true,
      alreadyGranted: false,
      item,
      rewards,
    };
  });
}

async function getLeaderboardForUid(uid: string, data: Record<string, unknown>) {
  const range =
    data.range === "today" || data.range === "weekly" || data.range === "all"
      ? data.range
      : "weekly";
  const audience = data.scope === "friends" ? "friends" : "global";
  const visibleLimit = clampInt(data.limit, 20, 1, 100);
  const queryLimit = audience === "friends" ? 300 : Math.max(visibleLimit, 100);
  const scoresRef = db.collection("scores");
  let query: FirebaseFirestore.Query = scoresRef;

  if (range === "today") query = query.where("playedAtDay", "==", dayKey());
  if (range === "weekly") query = query.where("playedAtWeek", "==", weekKey());
  if (range === "all") query = query.orderBy("score", "desc");
  query = query.limit(queryLimit);

  const [scoresSnapshot, friendsSnapshot] = await Promise.all([
    query.get(),
    audience === "friends" && uid
      ? db.collection(`friends/${uid}/items`).limit(100).get()
      : Promise.resolve(null),
  ]);
  const allowedUids =
    audience === "friends" && uid
      ? new Set([uid, ...(friendsSnapshot?.docs.map((doc) => doc.id) || [])])
      : null;
  const allEntries = scoresSnapshot.docs
    .map((doc) => {
      const score = doc.data() || {};
      return {
        id: doc.id,
        playerUid: typeof score.playerUid === "string" ? score.playerUid : "",
        nickname: sanitizeNickname(score.nickname),
        score: clampInt(score.score, 0, 0, 9999999),
        maxCombo: clampInt(score.maxCombo, 0, 0, 999),
        feverCount: clampInt(score.feverCount, 0, 0, 999),
        mode: "60s",
        version: typeof score.version === "string" ? score.version : "0.3.0",
        playedAtDay: typeof score.playedAtDay === "string" ? score.playedAtDay : dayKey(),
        playedAtWeek: typeof score.playedAtWeek === "string" ? score.playedAtWeek : weekKey(),
      };
    })
    .filter((entry) => !allowedUids || allowedUids.has(entry.playerUid))
    .sort((a, b) => b.score - a.score);
  const myIndex = uid ? allEntries.findIndex((entry) => entry.playerUid === uid) : -1;
  return {
    range,
    scope: audience,
    my: myIndex >= 0 ? { rank: myIndex + 1, score: allEntries[myIndex].score } : null,
    list: allEntries.slice(0, visibleLimit),
  };
}

async function getDailyCheckinForUid(uid: string) {
  const snapshot = await db.doc(`dailyCheckins/${uid}`).get();
  return buildDailyCheckinStatus(snapshot.data());
}

async function claimDailyCheckinForUid(uid: string) {
  const today = dayKey();
  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const checkinRef = db.doc(`dailyCheckins/${uid}`);
    const checkinSnapshot = await tx.get(checkinRef);
    const raw = checkinSnapshot.data() || {};
    const lastClaimedKey = typeof raw.lastClaimedKey === "string" ? raw.lastClaimedKey : "";
    const alreadyClaimed = lastClaimedKey === today;
    const previous = previousDayKey(today);
    const baseDay =
      lastClaimedKey === previous || alreadyClaimed ? clampInt(raw.cycleDay, 1, 1, 7) : 0;
    const currentDay = alreadyClaimed ? Math.min(7, baseDay) : Math.min(7, baseDay + 1 || 1);
    const claimed = Array.isArray(raw.claimed)
      ? raw.claimed.filter((day): day is number => Number.isInteger(day) && day >= 1 && day <= 7)
      : [];
    if (alreadyClaimed) {
      return {
        profile: publicProfile(profile),
        status: { currentDay, claimed, claimedToday: true },
        rewards: { stars: 0 },
      };
    }
    const reward = checkinRewards[currentDay - 1] || checkinRewards[0];
    const nextClaimed = [...new Set([...claimed, currentDay])];
    const nextProfile = { ...profile, stars: profile.stars + reward.stars };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      checkinRef,
      {
        claimed: nextClaimed,
        lastClaimedKey: today,
        cycleDay: currentDay,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return {
      profile: publicProfile(nextProfile),
      status: { currentDay, claimed: nextClaimed, claimedToday: true },
      rewards: { stars: reward.stars },
    };
  });
}

async function getDailyMissionForUid(uid: string) {
  const today = dayKey();
  const mission = pickDailyMission(today);
  const snapshot = await db.doc(`dailyMissions/${uid}`).get();
  const state = normalizeDailyMissionState(snapshot.data(), mission, today);
  return buildDailyMissionStatus(state, mission);
}

async function claimDailyMissionForUid(uid: string) {
  const today = dayKey();
  const mission = pickDailyMission(today);
  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const missionRef = db.doc(`dailyMissions/${uid}`);
    const missionSnapshot = await tx.get(missionRef);
    const missionState = normalizeDailyMissionState(missionSnapshot.data(), mission, today);
    const alreadyCompletedToday = profile.completedDailyKeys.includes(today);
    if (missionState.claimed || alreadyCompletedToday) {
      const claimedState = { ...missionState, claimed: true, progress: mission.goal };
      return {
        profile: publicProfile(profile),
        status: buildDailyMissionStatus(claimedState, mission),
        granted: false,
        rewards: { stars: 0 },
        message: "오늘의 도전 보상은 이미 받았어요.",
      };
    }
    if (missionState.progress < mission.goal) {
      throw new HttpsError("failed-precondition", "아직 오늘의 도전을 완료하지 못했어요.");
    }
    const completedDailyKeys = [...new Set([...profile.completedDailyKeys, today])]
      .sort()
      .slice(-31);
    const nextProfile = {
      ...profile,
      stars: clampInt(profile.stars + mission.rewardStars, profile.stars, 0, 99999999),
      streak:
        profile.lastDailyKey === today
          ? profile.streak
          : profile.lastDailyKey === previousDayKey(today)
            ? profile.streak + 1
            : 1,
      lastDailyKey: today,
      completedDailyKeys,
    };
    const nextMissionState = { ...missionState, claimed: true };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      missionRef,
      {
        ...nextMissionState,
        claimedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return {
      profile: publicProfile(nextProfile),
      status: buildDailyMissionStatus(nextMissionState, mission),
      granted: true,
      rewards: { stars: mission.rewardStars },
      message: `오늘의 도전 +${mission.rewardStars}별`,
    };
  });
}

async function getWeeklyMissionForUid(uid: string) {
  const currentWeek = weekKey();
  const snapshot = await db.doc(`weeklyMissions/${uid}`).get();
  const state = normalizeWeeklyMissionState(snapshot.data(), currentWeek);
  return buildWeeklyMissionStatus(state);
}

async function claimWeeklyMissionForUid(uid: string, missionId: unknown) {
  await assertRateLimit(uid, "weekly_mission_claim", 20, 60 * 1000);
  const mission = weeklyMissions.find((item) => item.id === missionId);
  if (!mission) {
    throw new HttpsError("invalid-argument", "주간 미션 ID가 올바르지 않아요.");
  }
  const currentWeek = weekKey();
  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const missionRef = db.doc(`weeklyMissions/${uid}`);
    const missionSnapshot = await tx.get(missionRef);
    const missionState = normalizeWeeklyMissionState(missionSnapshot.data(), currentWeek);
    const progress = missionState.missions[mission.id] || { progress: 0, claimed: false };
    if (progress.claimed) {
      return {
        profile: publicProfile(profile),
        status: buildWeeklyMissionStatus(missionState),
        granted: false,
        rewards: { stars: 0 },
        message: "주간 미션 보상은 이미 받았어요.",
      };
    }
    if (progress.progress < mission.goal) {
      throw new HttpsError("failed-precondition", "아직 주간 미션을 완료하지 못했어요.");
    }
    const nextProfile = {
      ...profile,
      stars: clampInt(profile.stars + mission.rewardStars, profile.stars, 0, 99999999),
    };
    const nextState = {
      ...missionState,
      missions: {
        ...missionState.missions,
        [mission.id]: {
          progress: Math.max(progress.progress, mission.goal),
          claimed: true,
        },
      },
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(missionRef, weeklyMissionDoc(nextState), { merge: true });
    return {
      profile: publicProfile(nextProfile),
      status: buildWeeklyMissionStatus(nextState),
      granted: true,
      rewards: { stars: mission.rewardStars },
      message: `주간 미션 +${mission.rewardStars}별`,
    };
  });
}

async function getSeasonPassForUid(uid: string) {
  const season = await getCurrentSeason();
  const [userSnapshot, passSnapshot] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`seasonPassClaims/${uid}`).get(),
  ]);
  const profile = recoverHearts(
    normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
  );
  const claims = normalizePassClaims(passSnapshot.data(), season.id);
  return buildSeasonPassStatus(profile, claims, season);
}

async function claimSeasonPassForUid(uid: string, data: Record<string, unknown>) {
  const level = clampInt(data.level, 0, 1, passTiers.length);
  if (!isPassTrack(data.track)) {
    throw new HttpsError("invalid-argument", "패스 트랙이 올바르지 않아요.");
  }
  const track = data.track;
  const tier = passTiers.find((item) => item.level === level);
  if (!tier) throw new HttpsError("not-found", "패스 보상을 찾을 수 없어요.");
  const season = await getCurrentSeason();
  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const passRef = db.doc(`seasonPassClaims/${uid}`);
    const passSnapshot = await tx.get(passRef);
    const claims = normalizePassClaims(passSnapshot.data(), season.id);
    const currentLevel = passLevelFromXp(profile.xp);
    if (tier.level > currentLevel) {
      throw new HttpsError("failed-precondition", "아직 열리지 않은 패스 보상이에요.");
    }
    if (track === "premium" && !profile.seasonPassPremium) {
      throw new HttpsError("failed-precondition", "프리미엄 패스가 필요해요.");
    }
    if (claims[track].includes(tier.level)) {
      return {
        profile: publicProfile(profile),
        status: buildSeasonPassStatus(profile, claims, season),
        granted: false,
        rewards: tier[track],
        message: "이미 받은 패스 보상이에요.",
      };
    }
    const nextClaims = {
      ...claims,
      [track]: [...claims[track], tier.level].sort((a, b) => a - b),
    };
    const nextProfile = applyPassReward(profile, tier[track]);
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      passRef,
      {
        ...nextClaims,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return {
      profile: publicProfile(nextProfile),
      status: buildSeasonPassStatus(nextProfile, nextClaims, season),
      granted: true,
      rewards: tier[track],
      message: `${tier[track].label} 수령 완료`,
    };
  });
}

async function getStageProgressForUid(uid: string) {
  const snapshot = await db.doc(`stageProgress/${uid}`).get();
  return { progress: normalizeStageProgress(snapshot.data()) };
}

async function clearStageForUid(uid: string, data: Record<string, unknown>) {
  const stageId = clampInt(data.stageId, 1, 1, 12);
  const earnedStars = clampInt(data.stars, 0, 0, 3);
  if (earnedStars <= 0) throw new HttpsError("failed-precondition", "저장할 별이 없어요.");
  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const progressRef = db.doc(`stageProgress/${uid}`);
    const progressSnapshot = await tx.get(progressRef);
    const raw = progressSnapshot.data() || {};
    const stars = (raw.stars || {}) as Record<string, number>;
    const key = String(stageId);
    const previousStars = clampInt(stars[key], 0, 0, 3);
    const nextStarsForStage = Math.max(previousStars, earnedStars);
    const rewardStars = Math.max(0, nextStarsForStage - previousStars) * 25;
    const currentStage = clampInt(raw.currentStage, 1, 1, 12);
    const nextProgress = {
      chapter: typeof raw.chapter === "string" ? raw.chapter : "ch1",
      currentStage: stageId >= currentStage ? Math.min(12, stageId + 1) : currentStage,
      stars: { ...stars, [key]: nextStarsForStage },
    };
    const nextProfile = { ...profile, stars: profile.stars + rewardStars };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      progressRef,
      { ...nextProgress, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return {
      profile: publicProfile(nextProfile),
      progress: nextProgress,
      rewards: { stars: rewardStars },
    };
  });
}

async function getCharacterDexForUid(uid: string) {
  const snapshot = await db.doc(`users/${uid}`).get();
  const profile = recoverHearts(
    normalizeProfile(uid, snapshot.exists ? snapshot.data() : undefined),
  );
  return { characters: buildCharacterDex(profile) };
}

async function setMainCharacterForUid(uid: string, data: Record<string, unknown>) {
  if (!isCharacterId(data.animal)) {
    throw new HttpsError("invalid-argument", "캐릭터가 올바르지 않아요.");
  }
  const animal = data.animal;
  return runUserTransaction(uid, (profile, userRef, tx) => {
    if (!profile.unlockedCharacters.includes(animal)) {
      throw new HttpsError("failed-precondition", "아직 잠긴 캐릭터예요.");
    }
    const nextProfile = { ...profile, mainCharacter: animal };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile), user: publicProfile(nextProfile) };
  });
}

async function levelUpCharacterForUid(uid: string, data: Record<string, unknown>) {
  if (!isCharacterId(data.animal)) {
    throw new HttpsError("invalid-argument", "캐릭터가 올바르지 않아요.");
  }
  const animal = data.animal;
  return runUserTransaction(uid, (profile, userRef, tx) => {
    if (!profile.unlockedCharacters.includes(animal)) {
      throw new HttpsError("failed-precondition", "아직 잠긴 캐릭터예요.");
    }
    const currentLevel = profile.characterLevels[animal] || 1;
    const cost = currentLevel * 80;
    if (profile.stars < cost) {
      return { profile: publicProfile(profile), leveled: false, cost };
    }
    const nextProfile = {
      ...profile,
      stars: profile.stars - cost,
      characterLevels: {
        ...profile.characterLevels,
        [animal]: currentLevel + 1,
      },
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile), leveled: true, cost };
  });
}

async function getLiveOpsConfigForUid(uid: string) {
  const [seasonSnapshot, shopSnapshot, bannerSnapshot, experimentSnapshot] = await Promise.all([
    db.doc("liveConfig/seasonCurrent").get(),
    db.doc("liveConfig/shopItems").get(),
    db.doc("liveConfig/eventBanners").get(),
    db.doc("liveConfig/experiments").get(),
  ]);
  const season = seasonSnapshot.exists
    ? { ...fallbackSeason, ...(exportValue(seasonSnapshot.data() || {}) as object) }
    : fallbackSeason;
  const rawShopItems = shopSnapshot.exists ? shopSnapshot.data()?.items : null;
  const rawBanners = bannerSnapshot.exists ? bannerSnapshot.data()?.items : null;
  const experimentDoc = experimentSnapshot.exists
    ? (experimentSnapshot.data() as Record<string, unknown>)
    : {};
  const experiments = EXPERIMENT_KEYS.reduce<Record<string, string>>((result, key) => {
    const variants = Array.isArray(experimentDoc[key])
      ? (experimentDoc[key] as unknown[]).filter((item): item is string => typeof item === "string")
      : fallbackExperiments[key];
    result[key] = stableVariant(uid, key, variants);
    return result;
  }, {});
  return {
    season,
    shopItems: Array.isArray(rawShopItems) ? rawShopItems.slice(0, 60) : fallbackShopItems,
    eventBanners: Array.isArray(rawBanners) ? rawBanners.slice(0, 12) : [],
    experiments,
    fetchedAt: new Date().toISOString(),
  };
}

async function getNotificationPreferencesForUid(uid: string) {
  const snapshot = await db.doc(`notificationPrefs/${uid}`).get();
  const raw = snapshot.data() || {};
  const topics = normalizeNotificationTopics(raw.topics);
  return {
    pushEnabled: raw.pushEnabled !== false,
    topics: topics.length
      ? topics
      : (["heart_full", "daily_reminder"] satisfies NotificationTopic[]),
  };
}

async function updateNotificationTopicsForUid(uid: string, data: Record<string, unknown>) {
  const topics = normalizeNotificationTopics(data.topics);
  const pushEnabled = data.pushEnabled !== false;
  await db.doc(`notificationPrefs/${uid}`).set(
    {
      pushEnabled,
      topics,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { pushEnabled, topics };
}

async function registerNotificationTokenForUid(uid: string, data: Record<string, unknown>) {
  if (typeof data.token !== "string" || data.token.length < 16 || data.token.length > 4096) {
    throw new HttpsError("invalid-argument", "푸시 토큰이 올바르지 않아요.");
  }
  if (!isNotificationPlatform(data.platform)) {
    throw new HttpsError("invalid-argument", "푸시 플랫폼이 올바르지 않아요.");
  }
  const topics = normalizeNotificationTopics(data.topics);
  const tokenHash = sha256(data.token);
  await db.doc(`notificationTokens/${uid}_${tokenHash.slice(0, 28)}`).set(
    {
      userId: uid,
      tokenHash,
      token: data.token,
      platform: data.platform,
      topics,
      active: true,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { registered: true, topics };
}

async function logTelemetryForUid(uid: string | null, data: Record<string, unknown>) {
  if (!isTelemetryEventName(data.name)) {
    throw new HttpsError("invalid-argument", "이벤트 이름이 올바르지 않아요.");
  }
  await db.collection("telemetryEvents").add({
    userId: uid,
    name: data.name,
    payload: sanitizeTelemetryPayload(data.payload),
    createdAt: FieldValue.serverTimestamp(),
  });
  return { logged: true };
}

async function queueVersusForUid(uid: string) {
  await assertRateLimit(uid, "versus_queue", 12, 60 * 1000);
  await assertNotBanned(uid);
  const userSnapshot = await db.doc(`users/${uid}`).get();
  const profile = recoverHearts(
    normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
  );
  const opponent = await pickVersusOpponent(uid, profile);
  const matchId = createVersusMatchId(uid);
  const seed = createServerMatchSeed(uid, matchId);
  const startedAtMs = Date.now();
  const startsAtMs = startedAtMs + 1500;
  const matchRef = db.doc(`matches/${matchId}`);
  const versusRef = db.doc(`versusMatches/${matchId}`);
  await db.runTransaction(async (tx) => {
    tx.set(matchRef, {
      userId: uid,
      mode: "versus",
      seed,
      status: "started",
      startedAtMs,
      accepted: false,
      rewardsClaimed: false,
      scoreSubmitted: false,
      version: "0.3.0",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(versusRef, {
      userId: uid,
      opponent,
      seed,
      status: "started",
      startedAtMs,
      startsAtMs,
      result: null,
      rpDelta: 0,
      rewards: { stars: 0 },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return {
    match: { matchId, mode: "versus", seed, startedAtMs, savedOnline: true },
    matchId,
    seed,
    opponent,
    startsAt: startsAtMs,
    startsAtMs,
  };
}

async function finishVersusForUid(uid: string, data: Record<string, unknown>) {
  await assertNotBanned(uid);
  if (typeof data.matchId !== "string") {
    throw new HttpsError("invalid-argument", "matchId가 필요해요.");
  }
  const matchId = data.matchId;
  const matchRef = db.doc(`matches/${matchId}`);
  const versusRef = db.doc(`versusMatches/${matchId}`);
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const [userSnapshot, matchSnapshot, versusSnapshot] = await Promise.all([
      tx.get(userRef),
      tx.get(matchRef),
      tx.get(versusRef),
    ]);
    if (!matchSnapshot.exists || !versusSnapshot.exists) {
      throw new HttpsError("not-found", "대전 세션을 찾을 수 없어요.");
    }
    const match = matchSnapshot.data() || {};
    const versus = versusSnapshot.data() || {};
    if (match.userId !== uid || versus.userId !== uid) {
      throw new HttpsError("permission-denied", "다른 계정의 대전이에요.");
    }
    if (match.mode !== "versus") {
      throw new HttpsError("failed-precondition", "대전 매치가 아니에요.");
    }
    if (match.status !== "finished" || match.accepted !== true) {
      throw new HttpsError("failed-precondition", "검증된 대전 점수만 확정돼요.");
    }
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const opponent = (versus.opponent || botOpponentFor(profile)) as VersusOpponent;
    const score = clampInt(match.score, 0, 0, 9999999);
    const opponentScore = clampInt(opponent.scoreTarget, 0, 0, 9999999);
    if (versus.status === "finished") {
      const previousResult = versus.result === "win" ? "win" : "lose";
      return {
        result: previousResult,
        rpDelta: clampInt(versus.rpDelta, 0, -9999, 9999),
        rewards: { stars: clampInt(versus.rewards?.stars, 0, 0, 999999) },
        playerScore: clampInt(versus.playerScore, score, 0, 9999999),
        opponentScore: clampInt(versus.opponentScore, opponentScore, 0, 9999999),
        opponent,
        profile: publicProfile(profile),
      };
    }
    const result = score >= opponentScore ? "win" : "lose";
    const rpDelta = result === "win" ? 24 : -14;
    const stars = result === "win" ? 12 : 3;
    const nextRp = clampInt(profile.rp + rpDelta, profile.rp, 0, 999999);
    const nextProfile = {
      ...profile,
      rp: nextRp,
      tier: tierFromRp(nextRp),
      stars: profile.stars + stars,
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      versusRef,
      {
        status: "finished",
        result,
        playerScore: score,
        opponentScore,
        rpDelta,
        rewards: { stars },
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return {
      result,
      rpDelta,
      rewards: { stars },
      playerScore: score,
      opponentScore,
      opponent,
      profile: publicProfile(nextProfile),
    };
  });
}

async function getFriendCodeForUid(uid: string) {
  const byUidRef = db.doc(`friendCodesByUid/${uid}`);
  const current = await byUidRef.get();
  const currentCode = current.data()?.code;
  if (typeof currentCode === "string" && currentCode.length === 6) {
    return { code: currentCode };
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = createFriendCodeValue();
    const result = await db.runTransaction(async (tx) => {
      const latest = await tx.get(byUidRef);
      const latestCode = latest.data()?.code;
      if (typeof latestCode === "string" && latestCode.length === 6) return latestCode;
      const codeRef = db.doc(`friendCodes/${code}`);
      const codeSnapshot = await tx.get(codeRef);
      if (codeSnapshot.exists && codeSnapshot.data()?.uid !== uid) return null;
      tx.set(
        byUidRef,
        {
          code,
          uid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.set(
        codeRef,
        { uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return code;
    });
    if (result) return { code: result };
  }
  throw new HttpsError("resource-exhausted", "친구 코드를 만들지 못했어요.");
}

async function getFriendsForUid(uid: string) {
  const [snapshot, blockSnapshot] = await Promise.all([
    db.collection(`friends/${uid}/items`).limit(100).get(),
    db.collection(`userBlocks/${uid}/items`).limit(100).get(),
  ]);
  const blockedIds = new Set(blockSnapshot.docs.map((doc) => doc.id));
  const friendIds = snapshot.docs
    .map((doc) => doc.id)
    .filter((id, index, list) => id !== uid && !blockedIds.has(id) && list.indexOf(id) === index)
    .slice(0, 100);
  if (!friendIds.length) return { friends: [] as FriendEntry[] };
  const profiles = await db.getAll(...friendIds.map((friendId) => db.doc(`users/${friendId}`)));
  const friends = profiles
    .filter((profile) => profile.exists)
    .map((profile) =>
      publicFriendEntry(normalizeProfile(profile.id, profile.data()), profile.data()),
    );
  return { friends };
}

async function inviteFriendForUid(uid: string, data: Record<string, unknown>) {
  await assertRateLimit(uid, "friend_invite", 20, 60 * 1000);
  await assertNotBanned(uid);
  let friendUid = "";
  if (typeof data.userId === "string" && data.userId.trim()) {
    friendUid = sanitizeUid(data.userId.trim());
  } else {
    const code = sanitizeFriendCode(data.code);
    const codeSnapshot = await db.doc(`friendCodes/${code}`).get();
    friendUid = typeof codeSnapshot.data()?.uid === "string" ? codeSnapshot.data()?.uid : "";
  }
  if (!friendUid) throw new HttpsError("not-found", "친구 코드를 찾을 수 없어요.");
  if (friendUid === uid) throw new HttpsError("failed-precondition", "내 코드는 추가할 수 없어요.");
  await assertNoBlockBetween(uid, friendUid);
  return db.runTransaction(async (tx) => {
    const selfRef = db.doc(`users/${uid}`);
    const friendRef = db.doc(`users/${friendUid}`);
    const [selfSnapshot, friendSnapshot] = await Promise.all([tx.get(selfRef), tx.get(friendRef)]);
    if (!friendSnapshot.exists) throw new HttpsError("not-found", "친구 프로필을 찾을 수 없어요.");
    const selfProfile = normalizeProfile(
      uid,
      selfSnapshot.exists ? selfSnapshot.data() : undefined,
    );
    const friendProfile = normalizeProfile(friendUid, friendSnapshot.data());
    const selfFriendRef = db.doc(`friends/${uid}/items/${friendUid}`);
    const friendSelfRef = db.doc(`friends/${friendUid}/items/${uid}`);
    const requestRef = db.doc(`friendRequests/${friendUid}/items/${uid}`);
    const payload = {
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (data.requestOnly === true) {
      tx.set(
        requestRef,
        {
          fromUserId: uid,
          toUserId: friendUid,
          nickname: selfProfile.nickname,
          animal: selfProfile.mainCharacter,
          status: "pending",
          ...payload,
        },
        { merge: true },
      );
      return {
        pending: true,
        friend: publicFriendEntry(friendProfile, friendSnapshot.data()),
        self: publicFriendEntry(selfProfile, selfSnapshot.data()),
      };
    }
    tx.set(selfFriendRef, { ...payload, friendId: friendUid }, { merge: true });
    tx.set(friendSelfRef, { ...payload, friendId: uid }, { merge: true });
    tx.delete(requestRef);
    return {
      pending: false,
      friend: publicFriendEntry(friendProfile, friendSnapshot.data()),
      self: publicFriendEntry(selfProfile, selfSnapshot.data()),
    };
  });
}

async function acceptFriendForUid(uid: string, data: Record<string, unknown>) {
  await assertRateLimit(uid, "friend_accept", 30, 60 * 1000);
  await assertNotBanned(uid);
  const friendUid = sanitizeUid(data.friendId);
  if (friendUid === uid) throw new HttpsError("failed-precondition", "내 계정은 추가할 수 없어요.");
  await assertNoBlockBetween(uid, friendUid);
  return db.runTransaction(async (tx) => {
    const selfRef = db.doc(`users/${uid}`);
    const friendRef = db.doc(`users/${friendUid}`);
    const requestRef = db.doc(`friendRequests/${uid}/items/${friendUid}`);
    const reverseRequestRef = db.doc(`friendRequests/${friendUid}/items/${uid}`);
    const [selfSnapshot, friendSnapshot] = await Promise.all([tx.get(selfRef), tx.get(friendRef)]);
    if (!friendSnapshot.exists) throw new HttpsError("not-found", "친구 프로필을 찾을 수 없어요.");
    const selfProfile = normalizeProfile(
      uid,
      selfSnapshot.exists ? selfSnapshot.data() : undefined,
    );
    const friendProfile = normalizeProfile(friendUid, friendSnapshot.data());
    const payload = {
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(
      db.doc(`friends/${uid}/items/${friendUid}`),
      { ...payload, friendId: friendUid },
      { merge: true },
    );
    tx.set(
      db.doc(`friends/${friendUid}/items/${uid}`),
      { ...payload, friendId: uid },
      { merge: true },
    );
    tx.delete(requestRef);
    tx.delete(reverseRequestRef);
    return {
      accepted: true,
      friend: publicFriendEntry(friendProfile, friendSnapshot.data()),
      self: publicFriendEntry(selfProfile, selfSnapshot.data()),
    };
  });
}

async function removeFriendForUid(uid: string, friendIdValue: unknown) {
  const friendId = sanitizeUid(friendIdValue);
  if (friendId === uid) throw new HttpsError("failed-precondition", "내 계정은 삭제할 수 없어요.");
  await db.runTransaction(async (tx) => {
    tx.delete(db.doc(`friends/${uid}/items/${friendId}`));
    tx.delete(db.doc(`friends/${friendId}/items/${uid}`));
  });
  return { removed: true, friendId };
}

async function getContactMatchesForUid(uid: string, data: Record<string, unknown>) {
  await assertRateLimit(uid, "contacts_match", 20, 60 * 1000);
  if (data.consent !== true && data.consent !== "true") return { matches: [] as FriendEntry[] };
  const hashes = sanitizeHashList(data.contactHashes);
  if (!hashes.length) return { matches: [] as FriendEntry[] };
  const candidates = new Set<string>();
  for (let index = 0; index < hashes.length; index += 10) {
    const chunk = hashes.slice(index, index + 10);
    const snapshot = await db
      .collection("userContactHashes")
      .where("hashes", "array-contains-any", chunk)
      .limit(50)
      .get();
    snapshot.docs.forEach((doc) => {
      if (doc.id !== uid) candidates.add(doc.id);
    });
  }
  const candidateIds = [...candidates].slice(0, 50);
  if (!candidateIds.length) return { matches: [] as FriendEntry[] };
  const [blockSnapshot, friendSnapshot, ...profiles] = await Promise.all([
    db.collection(`userBlocks/${uid}/items`).limit(100).get(),
    db.collection(`friends/${uid}/items`).limit(100).get(),
    ...candidateIds.map((candidateUid) => db.doc(`users/${candidateUid}`).get()),
  ]);
  const blocked = new Set(blockSnapshot.docs.map((doc) => doc.id));
  const existingFriends = new Set(friendSnapshot.docs.map((doc) => doc.id));
  const matches = profiles
    .filter(
      (profile) => profile.exists && !blocked.has(profile.id) && !existingFriends.has(profile.id),
    )
    .map((profile) =>
      publicFriendEntry(normalizeProfile(profile.id, profile.data()), profile.data()),
    );
  return { matches };
}

async function getGuildForUid(uid: string) {
  const userGuildSnapshot = await db.doc(`userGuilds/${uid}`).get();
  const guildId = userGuildSnapshot.exists ? userGuildSnapshot.data()?.guildId : "";
  if (typeof guildId !== "string" || !guildId) return { guild: null, members: [], boss: null };
  const guildSnapshot = await db.doc(`guilds/${guildId}`).get();
  if (!guildSnapshot.exists) return { guild: null, members: [], boss: null };
  const membersSnapshot = await db
    .collection(`guildMembers/${guildId}/items`)
    .orderBy("weeklyContribution", "desc")
    .limit(30)
    .get();
  const guild = publicGuild(guildId, guildSnapshot.data());
  return {
    guild,
    boss: guild.boss,
    members: membersSnapshot.docs.map((doc) => publicGuildMember(doc.id, doc.data())),
  };
}

async function createGuildForUid(uid: string, data: Record<string, unknown>) {
  await assertRateLimit(uid, "guild_create", 5, 60 * 1000);
  await assertNotBanned(uid);
  const name = sanitizeGuildName(data.name);
  const description = sanitizeGuildDescription(data.description);
  const guildId = createGuildId();
  return db.runTransaction(async (tx) => {
    const userGuildRef = db.doc(`userGuilds/${uid}`);
    const userRef = db.doc(`users/${uid}`);
    const guildRef = db.doc(`guilds/${guildId}`);
    const memberRef = db.doc(`guildMembers/${guildId}/items/${uid}`);
    const [userGuildSnapshot, userSnapshot] = await Promise.all([
      tx.get(userGuildRef),
      tx.get(userRef),
    ]);
    if (userGuildSnapshot.exists)
      throw new HttpsError("already-exists", "이미 가입한 길드가 있어요.");
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const boss = currentGuildBoss(undefined, 1);
    const guildDoc = {
      name,
      description,
      ownerId: uid,
      level: 1,
      memberCount: 1,
      weeklyScore: 0,
      rank: 0,
      boss,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const memberDoc = {
      guildId,
      userId: uid,
      nickname: profile.nickname,
      animal: profile.mainCharacter,
      role: "leader",
      weeklyContribution: 0,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(guildRef, guildDoc);
    tx.set(memberRef, memberDoc);
    tx.set(userGuildRef, {
      guildId,
      role: "leader",
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      guild: publicGuild(guildId, guildDoc),
      boss,
      members: [publicGuildMember(uid, memberDoc, profile)],
    };
  });
}

async function joinGuildForUid(uid: string, guildIdValue: unknown) {
  await assertRateLimit(uid, "guild_join", 10, 60 * 1000);
  await assertNotBanned(uid);
  const guildId = sanitizeGuildId(guildIdValue);
  return db.runTransaction(async (tx) => {
    const userGuildRef = db.doc(`userGuilds/${uid}`);
    const userRef = db.doc(`users/${uid}`);
    const guildRef = db.doc(`guilds/${guildId}`);
    const memberRef = db.doc(`guildMembers/${guildId}/items/${uid}`);
    const [userGuildSnapshot, userSnapshot, guildSnapshot] = await Promise.all([
      tx.get(userGuildRef),
      tx.get(userRef),
      tx.get(guildRef),
    ]);
    if (userGuildSnapshot.exists)
      throw new HttpsError("already-exists", "이미 가입한 길드가 있어요.");
    if (!guildSnapshot.exists) throw new HttpsError("not-found", "길드를 찾을 수 없어요.");
    const guild = publicGuild(guildId, guildSnapshot.data());
    if (guild.memberCount >= 30) {
      throw new HttpsError("resource-exhausted", "길드 정원이 가득 찼어요.");
    }
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const memberDoc = {
      guildId,
      userId: uid,
      nickname: profile.nickname,
      animal: profile.mainCharacter,
      role: "member",
      weeklyContribution: 0,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(memberRef, memberDoc);
    tx.set(userGuildRef, {
      guildId,
      role: "member",
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      guildRef,
      { memberCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return {
      guild: { ...guild, memberCount: guild.memberCount + 1 },
      boss: guild.boss,
      members: [publicGuildMember(uid, memberDoc, profile)],
    };
  });
}

async function leaveGuildForUid(uid: string, expectedGuildId?: unknown) {
  let leftGuildId = "";
  await db.runTransaction(async (tx) => {
    const userGuildRef = db.doc(`userGuilds/${uid}`);
    const userGuildSnapshot = await tx.get(userGuildRef);
    const guildId = userGuildSnapshot.exists ? userGuildSnapshot.data()?.guildId : "";
    if (typeof guildId !== "string" || !guildId) {
      throw new HttpsError("not-found", "가입한 길드가 없어요.");
    }
    if (expectedGuildId && sanitizeGuildId(expectedGuildId) !== guildId) {
      throw new HttpsError("permission-denied", "다른 길드 요청이에요.");
    }
    leftGuildId = guildId;
    const guildRef = db.doc(`guilds/${guildId}`);
    const memberRef = db.doc(`guildMembers/${guildId}/items/${uid}`);
    const guildSnapshot = await tx.get(guildRef);
    const guild = publicGuild(guildId, guildSnapshot.data());
    if (guild.ownerId === uid && guild.memberCount > 1) {
      throw new HttpsError("failed-precondition", "길드장은 멤버가 남아 있으면 나갈 수 없어요.");
    }
    tx.delete(userGuildRef);
    tx.delete(memberRef);
    if (guild.ownerId === uid) {
      tx.delete(guildRef);
    } else {
      tx.set(
        guildRef,
        { memberCount: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
  });
  return { guild: null, members: [], boss: null, leftGuildId };
}

async function getGuildMembersForUid(uid: string, guildIdValue: unknown) {
  const guildId = sanitizeGuildId(guildIdValue);
  const userGuildSnapshot = await db.doc(`userGuilds/${uid}`).get();
  if (userGuildSnapshot.data()?.guildId !== guildId) {
    throw new HttpsError("permission-denied", "가입한 길드 멤버만 볼 수 있어요.");
  }
  const snapshot = await db
    .collection(`guildMembers/${guildId}/items`)
    .orderBy("weeklyContribution", "desc")
    .limit(30)
    .get();
  return { members: snapshot.docs.map((doc) => publicGuildMember(doc.id, doc.data())) };
}

async function getGuildBossForUid(uid: string, guildIdValue: unknown) {
  const guildId = sanitizeGuildId(guildIdValue);
  const userGuildSnapshot = await db.doc(`userGuilds/${uid}`).get();
  if (userGuildSnapshot.data()?.guildId !== guildId) {
    throw new HttpsError("permission-denied", "가입한 길드 보스만 볼 수 있어요.");
  }
  const [guildSnapshot, membersSnapshot] = await Promise.all([
    db.doc(`guilds/${guildId}`).get(),
    db
      .collection(`guildMembers/${guildId}/items`)
      .orderBy("weeklyContribution", "desc")
      .limit(30)
      .get(),
  ]);
  if (!guildSnapshot.exists) throw new HttpsError("not-found", "길드를 찾을 수 없어요.");
  return {
    boss: publicGuild(guildId, guildSnapshot.data()).boss,
    contributions: membersSnapshot.docs.map((doc) => ({
      userId: doc.id,
      dmg: clampInt(doc.data().weeklyContribution, 0, 0, 999999999),
    })),
  };
}

async function kickGuildMemberForUid(uid: string, data: Record<string, unknown>) {
  await assertRateLimit(uid, "guild_kick", 10, 60 * 1000);
  await assertNotBanned(uid);
  const targetUid = sanitizeUid(data.userId);
  if (targetUid === uid) {
    throw new HttpsError("failed-precondition", "길드장은 내보내기 대신 나가기를 사용해주세요.");
  }
  let guildId = "";
  await db.runTransaction(async (tx) => {
    const ownerGuildRef = db.doc(`userGuilds/${uid}`);
    const ownerGuildSnapshot = await tx.get(ownerGuildRef);
    guildId = ownerGuildSnapshot.exists ? ownerGuildSnapshot.data()?.guildId : "";
    if (typeof guildId !== "string" || !guildId) {
      throw new HttpsError("not-found", "가입한 길드가 없어요.");
    }
    const guildRef = db.doc(`guilds/${guildId}`);
    const targetGuildRef = db.doc(`userGuilds/${targetUid}`);
    const targetMemberRef = db.doc(`guildMembers/${guildId}/items/${targetUid}`);
    const [guildSnapshot, targetGuildSnapshot, targetMemberSnapshot] = await Promise.all([
      tx.get(guildRef),
      tx.get(targetGuildRef),
      tx.get(targetMemberRef),
    ]);
    if (!guildSnapshot.exists) throw new HttpsError("not-found", "길드를 찾을 수 없어요.");
    const guild = publicGuild(guildId, guildSnapshot.data());
    if (guild.ownerId !== uid) {
      throw new HttpsError("permission-denied", "길드장만 멤버를 내보낼 수 있어요.");
    }
    if (!targetMemberSnapshot.exists || targetGuildSnapshot.data()?.guildId !== guildId) {
      throw new HttpsError("not-found", "길드 멤버를 찾을 수 없어요.");
    }
    tx.delete(targetGuildRef);
    tx.delete(targetMemberRef);
    tx.set(
      guildRef,
      { memberCount: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  });
  return { removed: true, guildId, userId: targetUid };
}

async function hitGuildBossForUid(uid: string, data: Record<string, unknown>) {
  await assertNotBanned(uid);
  if (typeof data.matchId !== "string") {
    throw new HttpsError("invalid-argument", "matchId가 필요해요.");
  }
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const matchRef = db.doc(`matches/${data.matchId}`);
    const [userSnapshot, matchSnapshot] = await Promise.all([tx.get(userRef), tx.get(matchRef)]);
    if (!matchSnapshot.exists) throw new HttpsError("not-found", "매치 세션을 찾을 수 없어요.");
    const match = matchSnapshot.data() || {};
    if (match.userId !== uid) throw new HttpsError("permission-denied", "다른 계정의 매치예요.");
    if (match.status !== "finished" || match.accepted !== true) {
      throw new HttpsError("failed-precondition", "검증된 매치만 길드 보스에 반영돼요.");
    }
    if (match.guildClaimed === true) {
      throw new HttpsError("already-exists", "이미 길드 보스에 반영된 매치예요.");
    }
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const contribution = await applyGuildContribution(
      tx,
      uid,
      profile,
      clampInt(match.score, 0, 0, 9999999),
    );
    if (!contribution) throw new HttpsError("not-found", "가입한 길드가 없어요.");
    tx.set(
      matchRef,
      {
        guildClaimed: true,
        guildDamage: contribution.damage,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return contribution;
  });
}

function restQueryData(query: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(query || {}).map(([key, value]) => [key, firstQueryValue(value)]),
  );
}

function routeParam(path: string, pattern: RegExp) {
  const match = path.match(pattern);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function httpStatus(error: unknown) {
  if (!(error instanceof HttpsError)) return 500;
  if (error.code === "invalid-argument") return 400;
  if (error.code === "unauthenticated") return 401;
  if (error.code === "permission-denied") return 403;
  if (error.code === "not-found") return 404;
  if (error.code === "already-exists") return 409;
  if (error.code === "resource-exhausted") return 429;
  if (error.code === "failed-precondition") return 412;
  if (error.code === "deadline-exceeded") return 410;
  return 500;
}

function routeMatches(path: string, route: string) {
  return path === route || path.endsWith(route);
}

export const api = onRequest(async (request, response) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (request.method === "OPTIONS") {
    response.status(204).send("");
    return;
  }

  try {
    const path = request.path || new URL(request.url, "https://local").pathname;
    const data =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    const queryData = restQueryData(request.query as Record<string, unknown>);

    if (request.method === "POST" && routeMatches(path, "/auth/login")) {
      response.json(await loginRestAuth(data));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/auth/refresh")) {
      response.json(await rotateAuthRefreshToken(data.refreshToken));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/auth/link")) {
      response.json(await linkRestAuth(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/auth/restore")) {
      const existingToken = bearerToken(request.headers.authorization);
      const uid = existingToken
        ? verifySessionJwt(existingToken).sub
        : (await auth.createUser({ displayName: "게스트" })).uid;
      response.json(await restoreRestAuth(uid, data.code));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/auth/me")) {
      const uid = await authUidFromRestRequest(request);
      response.json({ user: await upsertAuthProfile(uid) });
      return;
    }
    if (request.method === "DELETE" && routeMatches(path, "/auth/me")) {
      const uid = await authUidFromRestRequest(request);
      response.json(await deletePlayerAccountData(uid));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/me/profile")) {
      const uid = await authUidFromRestRequest(request);
      const profile = await upsertAuthProfile(uid);
      response.json({ user: profile, profile });
      return;
    }
    if (request.method === "PATCH" && routeMatches(path, "/me/profile")) {
      response.json(await updatePlayerProfileForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/me/stats")) {
      response.json(await getPlayerStatsForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/me/heart/consume")) {
      response.json(await consumeHeartForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/me/heart/refill")) {
      response.json(await refillHeartForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/me/heart/timer-claim")) {
      response.json(await claimHeartTimerForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/match/start")) {
      response.json(await createMatchSessionForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/match/finish")) {
      response.json(await finishMatchRestForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/shop/items")) {
      response.json(await getShopItemsForRest());
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/iap/verify")) {
      response.json(await verifyIapPurchaseForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/ranking")) {
      const token = bearerToken(request.headers.authorization);
      response.json(
        await getLeaderboardForUid(token ? verifySessionJwt(token).sub : "", {
          ...queryData,
          ...data,
        }),
      );
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/season/current")) {
      response.json({ season: await getCurrentSeason() });
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/daily/checkin/status")) {
      response.json(await getDailyCheckinForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/daily/checkin/claim")) {
      response.json(await claimDailyCheckinForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/missions/today")) {
      response.json(await getDailyMissionForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/missions/week")) {
      response.json(await getWeeklyMissionForUid(await authUidFromRestRequest(request)));
      return;
    }
    const missionClaimId = routeParam(path, /\/missions\/([^/]+)\/claim$/);
    if (request.method === "POST" && missionClaimId) {
      const uid = await authUidFromRestRequest(request);
      const todayMissionId = pickDailyMission(dayKey()).id;
      response.json(
        missionClaimId === "today" || missionClaimId === todayMissionId
          ? await claimDailyMissionForUid(uid)
          : await claimWeeklyMissionForUid(uid, missionClaimId),
      );
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/pass/current")) {
      response.json(await getSeasonPassForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/pass/claim")) {
      response.json(await claimSeasonPassForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/pass/purchase-premium")) {
      response.json(
        await verifyIapPurchaseForUid(await authUidFromRestRequest(request), {
          ...data,
          productId: data.productId || "season_pass_s2",
        }),
      );
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/stages/progress")) {
      response.json(await getStageProgressForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/stages/clear")) {
      response.json(await clearStageForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/characters/dex")) {
      response.json(await getCharacterDexForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/characters/main")) {
      response.json(await setMainCharacterForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/characters/level-up")) {
      response.json(await levelUpCharacterForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/versus/queue")) {
      response.json(await queueVersusForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/versus/finish")) {
      response.json(await finishVersusForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/friends/code")) {
      response.json(await getFriendCodeForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/friends")) {
      response.json(await getFriendsForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/friends/invite")) {
      response.json(await inviteFriendForUid(await authUidFromRestRequest(request), data));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/friends/accept")) {
      response.json(await acceptFriendForUid(await authUidFromRestRequest(request), data));
      return;
    }
    const friendDeleteId = routeParam(path, /\/friends\/([^/]+)$/);
    if (request.method === "DELETE" && friendDeleteId) {
      response.json(
        await removeFriendForUid(await authUidFromRestRequest(request), friendDeleteId),
      );
      return;
    }
    if (
      (request.method === "GET" || request.method === "POST") &&
      routeMatches(path, "/friends/contacts")
    ) {
      response.json(
        await getContactMatchesForUid(await authUidFromRestRequest(request), {
          ...queryData,
          ...data,
        }),
      );
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/guilds/me")) {
      response.json(await getGuildForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/guilds")) {
      response.json(await createGuildForUid(await authUidFromRestRequest(request), data));
      return;
    }
    const guildJoinId = routeParam(path, /\/guilds\/([^/]+)\/join$/);
    if (request.method === "POST" && guildJoinId) {
      response.json(await joinGuildForUid(await authUidFromRestRequest(request), guildJoinId));
      return;
    }
    const guildLeaveId = routeParam(path, /\/guilds\/([^/]+)\/leave$/);
    if (request.method === "POST" && guildLeaveId) {
      response.json(await leaveGuildForUid(await authUidFromRestRequest(request), guildLeaveId));
      return;
    }
    const guildMembersId = routeParam(path, /\/guilds\/([^/]+)\/members$/);
    if (request.method === "GET" && guildMembersId) {
      response.json(
        await getGuildMembersForUid(await authUidFromRestRequest(request), guildMembersId),
      );
      return;
    }
    const guildKickId = routeParam(path, /\/guilds\/([^/]+)\/kick$/);
    if (request.method === "POST" && guildKickId) {
      response.json(
        await kickGuildMemberForUid(await authUidFromRestRequest(request), {
          ...data,
          guildId: guildKickId,
        }),
      );
      return;
    }
    const guildBossHitId = routeParam(path, /\/guilds\/([^/]+)\/boss\/hit$/);
    if (request.method === "POST" && guildBossHitId) {
      response.json(
        await hitGuildBossForUid(await authUidFromRestRequest(request), {
          ...data,
          guildId: guildBossHitId,
        }),
      );
      return;
    }
    const guildBossId = routeParam(path, /\/guilds\/([^/]+)\/boss$/);
    if (request.method === "GET" && guildBossId) {
      response.json(await getGuildBossForUid(await authUidFromRestRequest(request), guildBossId));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/liveops/config")) {
      const token = bearerToken(request.headers.authorization);
      response.json(
        await getLiveOpsConfigForUid(token ? verifySessionJwt(token).sub : "anonymous"),
      );
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/notifications/topics")) {
      response.json(await getNotificationPreferencesForUid(await authUidFromRestRequest(request)));
      return;
    }
    if (request.method === "PATCH" && routeMatches(path, "/notifications/topics")) {
      response.json(
        await updateNotificationTopicsForUid(await authUidFromRestRequest(request), data),
      );
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/notifications/register")) {
      response.json(
        await registerNotificationTokenForUid(await authUidFromRestRequest(request), data),
      );
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/telemetry/events")) {
      const token = bearerToken(request.headers.authorization);
      response.json(await logTelemetryForUid(token ? verifySessionJwt(token).sub : null, data));
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/ads/ssv/admob")) {
      response.json(
        await grantAdMobSsvReward({
          query: request.query as Record<string, unknown>,
          url: request.url,
          originalUrl: request.originalUrl,
        }),
      );
      return;
    }
    if (request.method === "GET" && routeMatches(path, "/ads/ssv/unity")) {
      const result = await grantUnitySsvReward({
        query: request.query as Record<string, unknown>,
      });
      response.status(200).send(`<status>${result.rewardId}:OK</status>`);
      return;
    }
    if (request.method === "POST" && routeMatches(path, "/ads/reward")) {
      const uid = await authUidFromRestRequest(request);
      await assertRateLimit(uid, "ad_reward", 12, 60 * 1000);
      const rewardType = isAdRewardType(data.rewardType)
        ? data.rewardType
        : adRewardTypeFromProvider(data.rewardType);
      const rewardId =
        typeof data.rewardId === "string" && data.rewardId.length <= 80
          ? data.rewardId.replace(/[^A-Za-z0-9:_-]/g, "")
          : `${dayKey()}_${randomBytes(6).toString("hex")}`;
      response.json(
        await grantAdReward({
          uid,
          rewardId,
          rewardType,
          verification: verifyAdRewardSignature({
            uid,
            rewardId,
            rewardType,
            adNetwork: data.adNetwork,
            signature: data.signature,
            timestamp: data.timestamp,
            nonce: data.nonce,
          }),
        }),
      );
      return;
    }

    response
      .status(404)
      .json({ error: { code: "not-found", message: "API 경로를 찾을 수 없어요." } });
  } catch (error) {
    const code = error instanceof HttpsError ? error.code : "internal";
    const message = error instanceof Error ? error.message : "요청 처리에 실패했어요.";
    response.status(httpStatus(error)).json({ error: { code, message } });
  }
});

export const startMatchSession = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "match_start", 30, 60 * 1000);
  await assertNotBanned(uid);
  const data = request.data as { matchId?: unknown; mode?: unknown };
  const mode = isMatchMode(data.mode) ? data.mode : "rush";
  const matchId = sanitizeMatchId(data.matchId, uid);
  const seed = createServerMatchSeed(uid, matchId);
  const startedAtMs = Date.now();
  const matchRef = db.doc(`matches/${matchId}`);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(matchRef);
    if (snapshot.exists) {
      throw new HttpsError("already-exists", "이미 사용 중인 매치 ID예요.");
    }
    tx.set(matchRef, {
      userId: uid,
      mode,
      seed,
      status: "started",
      startedAtMs,
      accepted: false,
      rewardsClaimed: false,
      scoreSubmitted: false,
      version: "0.3.0",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    matchId,
    mode,
    seed,
    startedAtMs,
    savedOnline: true,
  };
});

export const queueVersus = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "versus_queue", 12, 60 * 1000);
  await assertNotBanned(uid);
  const userSnapshot = await db.doc(`users/${uid}`).get();
  const profile = recoverHearts(
    normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
  );
  const opponent = await pickVersusOpponent(uid, profile);
  const matchId = createVersusMatchId(uid);
  const seed = createServerMatchSeed(uid, matchId);
  const startedAtMs = Date.now();
  const startsAtMs = startedAtMs + 1500;
  const matchRef = db.doc(`matches/${matchId}`);
  const versusRef = db.doc(`versusMatches/${matchId}`);

  await db.runTransaction(async (tx) => {
    tx.set(matchRef, {
      userId: uid,
      mode: "versus",
      seed,
      status: "started",
      startedAtMs,
      accepted: false,
      rewardsClaimed: false,
      scoreSubmitted: false,
      version: "0.3.0",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(versusRef, {
      userId: uid,
      opponent,
      seed,
      status: "started",
      startedAtMs,
      startsAtMs,
      result: null,
      rpDelta: 0,
      rewards: { stars: 0 },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    match: {
      matchId,
      mode: "versus",
      seed,
      startedAtMs,
      savedOnline: true,
    },
    opponent,
    startsAtMs,
  };
});

export const finishMatchSession = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertNotBanned(uid);
  const data = request.data as {
    matchId?: unknown;
    mode?: unknown;
    seed?: unknown;
    startedAtMs?: unknown;
    score?: unknown;
    maxCombo?: unknown;
    matchedCells?: unknown;
    specialTriggers?: unknown;
    feverCount?: unknown;
    rewards?: { xp?: unknown; stars?: unknown };
    replay?: unknown;
  };

  if (typeof data.matchId !== "string") {
    throw new HttpsError("invalid-argument", "matchId가 필요해요.");
  }
  const run: RunProgressPatch = {
    matchId: data.matchId,
    score: clampInt(data.score, 0, 0, 9999999),
    matchedCells: clampInt(data.matchedCells, 0, 0, 99999),
    maxCombo: clampInt(data.maxCombo, 0, 0, 999),
    specialTriggers: clampInt(data.specialTriggers, 0, 0, 99999),
    feverCount: clampInt(data.feverCount, 0, 0, 999),
  };
  const replay = normalizeReplay(data.replay);
  const matchRef = db.doc(`matches/${data.matchId}`);

  return db.runTransaction(async (tx) => {
    const [snapshot, userSnapshot] = await Promise.all([
      tx.get(matchRef),
      tx.get(db.doc(`users/${uid}`)),
    ]);
    if (!snapshot.exists) throw new HttpsError("not-found", "매치 세션을 찾을 수 없어요.");
    const match = snapshot.data() || {};
    if (match.userId !== uid) throw new HttpsError("permission-denied", "다른 계정의 매치예요.");
    if (match.status === "finished") {
      return { accepted: match.accepted === true, savedOnline: true };
    }
    if (match.status !== "started") {
      throw new HttpsError("failed-precondition", "시작된 매치가 아니에요.");
    }
    if (typeof data.seed !== "string" || data.seed !== match.seed) {
      throw new HttpsError("permission-denied", "매치 시드가 일치하지 않아요.");
    }
    const startedAtMs = clampInt(match.startedAtMs, 0, 0, Date.now());
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const accepted = validateRunPlausibility(run, durationMs, replay, profile);
    const rewards = {
      xp: clampInt(data.rewards?.xp, 0, 0, 99999999),
      stars: clampInt(data.rewards?.stars, 0, 0, 99999999),
    };

    tx.set(
      matchRef,
      {
        mode: isMatchMode(data.mode) ? data.mode : match.mode || "rush",
        status: "finished",
        durationMs,
        score: run.score,
        maxCombo: run.maxCombo,
        matchedCells: run.matchedCells,
        specialTriggers: run.specialTriggers,
        feverCount: run.feverCount,
        rewards,
        replay,
        moveCount: replay.length,
        accepted,
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { accepted, savedOnline: true };
  });
});

export const submitLeaderboardScore = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertNotBanned(uid);
  const data = request.data as { runId?: unknown; nickname?: unknown };
  if (typeof data.runId !== "string") {
    throw new HttpsError("invalid-argument", "runId가 필요해요.");
  }

  const matchRef = db.doc(`matches/${data.runId}`);
  const scoreRef = db.doc(`scores/${data.runId}`);
  return db.runTransaction(async (tx) => {
    const [matchSnapshot, scoreSnapshot] = await Promise.all([tx.get(matchRef), tx.get(scoreRef)]);
    if (!matchSnapshot.exists) throw new HttpsError("not-found", "매치 세션을 찾을 수 없어요.");
    const match = matchSnapshot.data() || {};
    if (match.userId !== uid) throw new HttpsError("permission-denied", "다른 계정의 기록이에요.");
    if (match.status !== "finished" || match.accepted !== true) {
      throw new HttpsError("failed-precondition", "검증된 매치만 랭킹에 등록돼요.");
    }

    const nickname = sanitizeNickname(data.nickname);
    const score = clampInt(match.score, 0, 1, 9999999);
    const entry = {
      nickname,
      playerUid: uid,
      score,
      maxCombo: clampInt(match.maxCombo, 0, 0, 999),
      feverCount: clampInt(match.feverCount, 0, 0, 999),
      mode: "60s",
      version: "0.3.0",
      playedAtDay: dayKey(),
      playedAtWeek: weekKey(),
    };

    if (!scoreSnapshot.exists) {
      tx.set(scoreRef, { ...entry, createdAt: FieldValue.serverTimestamp() });
      tx.set(
        matchRef,
        { scoreSubmitted: true, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }

    return { id: data.runId, ...entry, savedOnline: true };
  });
});

export const finishVersus = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertNotBanned(uid);
  const data = request.data as { matchId?: unknown };
  if (typeof data.matchId !== "string") {
    throw new HttpsError("invalid-argument", "matchId가 필요해요.");
  }
  const matchId = data.matchId;
  const matchRef = db.doc(`matches/${matchId}`);
  const versusRef = db.doc(`versusMatches/${matchId}`);

  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const [userSnapshot, matchSnapshot, versusSnapshot] = await Promise.all([
      tx.get(userRef),
      tx.get(matchRef),
      tx.get(versusRef),
    ]);
    if (!matchSnapshot.exists || !versusSnapshot.exists) {
      throw new HttpsError("not-found", "대전 세션을 찾을 수 없어요.");
    }
    const match = matchSnapshot.data() || {};
    const versus = versusSnapshot.data() || {};
    if (match.userId !== uid || versus.userId !== uid) {
      throw new HttpsError("permission-denied", "다른 계정의 대전이에요.");
    }
    if (match.mode !== "versus") {
      throw new HttpsError("failed-precondition", "대전 매치가 아니에요.");
    }
    if (match.status !== "finished" || match.accepted !== true) {
      throw new HttpsError("failed-precondition", "검증된 대전 점수만 확정돼요.");
    }

    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const opponent = (versus.opponent || botOpponentFor(profile)) as VersusOpponent;
    const score = clampInt(match.score, 0, 0, 9999999);
    const opponentScore = clampInt(opponent.scoreTarget, 0, 0, 9999999);
    if (versus.status === "finished") {
      const previousResult = versus.result === "win" ? "win" : "lose";
      return {
        result: previousResult,
        rpDelta: clampInt(versus.rpDelta, 0, -9999, 9999),
        rewards: {
          stars: clampInt(versus.rewards?.stars, 0, 0, 999999),
        },
        playerScore: clampInt(versus.playerScore, score, 0, 9999999),
        opponentScore: clampInt(versus.opponentScore, opponentScore, 0, 9999999),
        opponent,
        profile: publicProfile(profile),
      };
    }
    const result = score >= opponentScore ? "win" : "lose";
    const rpDelta = result === "win" ? 24 : -14;
    const stars = result === "win" ? 12 : 3;
    const nextRp = clampInt(profile.rp + rpDelta, profile.rp, 0, 999999);
    const nextProfile = {
      ...profile,
      rp: nextRp,
      tier: tierFromRp(nextRp),
      stars: profile.stars + stars,
    };

    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      versusRef,
      {
        status: "finished",
        result,
        playerScore: score,
        opponentScore,
        rpDelta,
        rewards: { stars },
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      result,
      rpDelta,
      rewards: { stars },
      playerScore: score,
      opponentScore,
      opponent,
      profile: publicProfile(nextProfile),
    };
  });
});

export const getLeaderboard = onCall(async (request) => {
  const uid = request.auth?.uid || "";
  const data = request.data as {
    range?: unknown;
    scope?: unknown;
    limit?: unknown;
  };
  const range =
    data.range === "today" || data.range === "weekly" || data.range === "all"
      ? data.range
      : "weekly";
  const audience = data.scope === "friends" ? "friends" : "global";
  const visibleLimit = clampInt(data.limit, 20, 1, 100);
  const queryLimit = audience === "friends" ? 300 : Math.max(visibleLimit, 100);
  const scoresRef = db.collection("scores");
  let query: FirebaseFirestore.Query = scoresRef;

  if (range === "today") query = query.where("playedAtDay", "==", dayKey());
  if (range === "weekly") query = query.where("playedAtWeek", "==", weekKey());
  if (range === "all") query = query.orderBy("score", "desc");
  query = query.limit(queryLimit);

  const [scoresSnapshot, friendsSnapshot] = await Promise.all([
    query.get(),
    audience === "friends" && uid
      ? db.collection(`friends/${uid}/items`).limit(100).get()
      : Promise.resolve(null),
  ]);

  const allowedUids =
    audience === "friends" && uid
      ? new Set([uid, ...(friendsSnapshot?.docs.map((doc) => doc.id) || [])])
      : null;
  const allEntries = scoresSnapshot.docs
    .map((doc) => {
      const score = doc.data() || {};
      return {
        id: doc.id,
        playerUid: typeof score.playerUid === "string" ? score.playerUid : "",
        nickname: sanitizeNickname(score.nickname),
        score: clampInt(score.score, 0, 0, 9999999),
        maxCombo: clampInt(score.maxCombo, 0, 0, 999),
        feverCount: clampInt(score.feverCount, 0, 0, 999),
        mode: "60s",
        version: typeof score.version === "string" ? score.version : "0.3.0",
        playedAtDay: typeof score.playedAtDay === "string" ? score.playedAtDay : dayKey(),
        playedAtWeek: typeof score.playedAtWeek === "string" ? score.playedAtWeek : weekKey(),
      };
    })
    .filter((entry) => !allowedUids || allowedUids.has(entry.playerUid))
    .sort((a, b) => b.score - a.score);

  const myIndex = uid ? allEntries.findIndex((entry) => entry.playerUid === uid) : -1;
  return {
    range,
    scope: audience,
    my: myIndex >= 0 ? { rank: myIndex + 1, score: allEntries[myIndex].score } : null,
    list: allEntries.slice(0, visibleLimit),
  };
});

function seasonRewardStars(rank: number, total: number, topPercent: number) {
  if (rank === 1) return 500;
  const percentile = (rank / Math.max(1, total)) * 100;
  if (percentile <= Math.min(10, topPercent)) return 250;
  return 120;
}

async function settleSeasonLeaderboardRewards(input: {
  seasonId: string;
  range: SeasonRewardRange;
  week?: string;
  topPercent: number;
}) {
  const queryLimit = 1000;
  let query: FirebaseFirestore.Query = db.collection("scores");
  if (input.range === "weekly") {
    query = query.where(
      "playedAtWeek",
      "==",
      input.week || weekKey(new Date(Date.now() - 7 * 86400000)),
    );
  }
  const snapshot = await query.orderBy("score", "desc").limit(queryLimit).get();
  const bestByUser = new Map<string, { playerUid: string; score: number; scoreId: string }>();
  snapshot.docs.forEach((doc) => {
    const score = doc.data();
    const playerUid = typeof score.playerUid === "string" ? score.playerUid : "";
    if (!playerUid || bestByUser.has(playerUid)) return;
    bestByUser.set(playerUid, {
      playerUid,
      score: clampInt(score.score, 0, 0, 9999999),
      scoreId: doc.id,
    });
  });

  const ranked = [...bestByUser.values()].sort((a, b) => b.score - a.score);
  const cutoff = Math.ceil(ranked.length * (input.topPercent / 100));
  const winners = ranked.slice(0, cutoff);
  let grantedCount = 0;
  let skippedCount = 0;

  for (const [index, winner] of winners.entries()) {
    const rank = index + 1;
    const rewardStars = seasonRewardStars(rank, ranked.length, input.topPercent);
    const rewardId = sha256(`${input.seasonId}:${input.range}:${winner.playerUid}`).slice(0, 40);
    const rewardRef = db.doc(`seasonRewards/${rewardId}`);
    const granted = await db.runTransaction(async (tx) => {
      const [rewardSnapshot, userSnapshot] = await Promise.all([
        tx.get(rewardRef),
        tx.get(db.doc(`users/${winner.playerUid}`)),
      ]);
      if (rewardSnapshot.exists || !userSnapshot.exists) {
        return false;
      }
      const profile = recoverHearts(normalizeProfile(winner.playerUid, userSnapshot.data()));
      const nextProfile = {
        ...profile,
        stars: clampInt(profile.stars + rewardStars, profile.stars, 0, 99999999),
      };
      tx.set(
        db.doc(`users/${winner.playerUid}`),
        { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      tx.set(rewardRef, {
        userId: winner.playerUid,
        seasonId: input.seasonId,
        range: input.range,
        week: input.week || null,
        rank,
        totalRanked: ranked.length,
        score: winner.score,
        scoreId: winner.scoreId,
        rewards: { stars: rewardStars },
        grantedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (granted) grantedCount += 1;
    else skippedCount += 1;
  }

  return {
    seasonId: input.seasonId,
    range: input.range,
    week: input.week || null,
    rankedCount: ranked.length,
    winnerCount: winners.length,
    grantedCount,
    skippedCount,
  };
}

export const settleSeasonRewards = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  assertLiveOpsAdmin(uid);
  await assertRateLimit(uid, "season_reward_settle", 6, 60 * 1000);
  const data = request.data as {
    seasonId?: unknown;
    range?: unknown;
    week?: unknown;
    topPercent?: unknown;
  };
  const season = await getCurrentSeason();
  const range = sanitizeSeasonRewardRange(data.range);
  const week =
    typeof data.week === "string" && /^\d{4}-W\d{2}$/.test(data.week)
      ? data.week
      : weekKey(new Date(Date.now() - 7 * 86400000));
  return settleSeasonLeaderboardRewards({
    seasonId: sanitizeSeasonRewardId(data.seasonId, season.id),
    range,
    week: range === "weekly" ? week : undefined,
    topPercent: clampInt(data.topPercent, 20, 1, 50),
  });
});

export const settleWeeklySeasonRewards = onSchedule(
  { schedule: "10 0 * * 1", timeZone: "Asia/Seoul" },
  async () => {
    const season = await getCurrentSeason();
    await settleSeasonLeaderboardRewards({
      seasonId: season.id,
      range: "weekly",
      week: weekKey(new Date(Date.now() - 7 * 86400000)),
      topPercent: 20,
    });
  },
);

export const getDailyCheckinStatus = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const snapshot = await db.doc(`dailyCheckins/${uid}`).get();
  return buildDailyCheckinStatus(snapshot.data());
});

export const claimDailyCheckin = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const today = dayKey();
  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const checkinRef = db.doc(`dailyCheckins/${uid}`);
    const checkinSnapshot = await tx.get(checkinRef);
    const raw = checkinSnapshot.data() || {};
    const lastClaimedKey = typeof raw.lastClaimedKey === "string" ? raw.lastClaimedKey : "";
    const alreadyClaimed = lastClaimedKey === today;
    const previous = previousDayKey(today);
    const baseDay =
      lastClaimedKey === previous || alreadyClaimed ? clampInt(raw.cycleDay, 1, 1, 7) : 0;
    const currentDay = alreadyClaimed ? Math.min(7, baseDay) : Math.min(7, baseDay + 1 || 1);
    const claimed = Array.isArray(raw.claimed)
      ? raw.claimed.filter((day): day is number => Number.isInteger(day) && day >= 1 && day <= 7)
      : [];
    if (alreadyClaimed) {
      return {
        profile: publicProfile(profile),
        status: { currentDay, claimed, claimedToday: true },
        rewards: { stars: 0 },
      };
    }

    const reward = checkinRewards[currentDay - 1] || checkinRewards[0];
    const nextClaimed = [...new Set([...claimed, currentDay])];
    const nextProfile = { ...profile, stars: profile.stars + reward.stars };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      checkinRef,
      {
        claimed: nextClaimed,
        lastClaimedKey: today,
        cycleDay: currentDay,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return {
      profile: publicProfile(nextProfile),
      status: { currentDay, claimed: nextClaimed, claimedToday: true },
      rewards: { stars: reward.stars },
    };
  });
});

export const getDailyMissionStatus = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const today = dayKey();
  const mission = pickDailyMission(today);
  const snapshot = await db.doc(`dailyMissions/${uid}`).get();
  const state = normalizeDailyMissionState(snapshot.data(), mission, today);
  return buildDailyMissionStatus(state, mission);
});

export const claimDailyMission = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const today = dayKey();
  const mission = pickDailyMission(today);

  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const missionRef = db.doc(`dailyMissions/${uid}`);
    const missionSnapshot = await tx.get(missionRef);
    const missionState = normalizeDailyMissionState(missionSnapshot.data(), mission, today);
    const alreadyCompletedToday = profile.completedDailyKeys.includes(today);

    if (missionState.claimed || alreadyCompletedToday) {
      const claimedState = { ...missionState, claimed: true, progress: mission.goal };
      return {
        profile: publicProfile(profile),
        status: buildDailyMissionStatus(claimedState, mission),
        granted: false,
        rewards: { stars: 0 },
        message: "오늘의 도전 보상은 이미 받았어요.",
      };
    }

    if (missionState.progress < mission.goal) {
      throw new HttpsError("failed-precondition", "아직 오늘의 도전을 완료하지 못했어요.");
    }

    const completedDailyKeys = [...new Set([...profile.completedDailyKeys, today])]
      .sort()
      .slice(-31);
    const nextProfile = {
      ...profile,
      stars: clampInt(profile.stars + mission.rewardStars, profile.stars, 0, 99999999),
      streak:
        profile.lastDailyKey === today
          ? profile.streak
          : profile.lastDailyKey === previousDayKey(today)
            ? profile.streak + 1
            : 1,
      lastDailyKey: today,
      completedDailyKeys,
    };
    const nextMissionState = { ...missionState, claimed: true };

    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      missionRef,
      {
        ...nextMissionState,
        claimedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      profile: publicProfile(nextProfile),
      status: buildDailyMissionStatus(nextMissionState, mission),
      granted: true,
      rewards: { stars: mission.rewardStars },
      message: `오늘의 도전 +${mission.rewardStars}별`,
    };
  });
});

export const getWeeklyMissionStatus = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const currentWeek = weekKey();
  const snapshot = await db.doc(`weeklyMissions/${uid}`).get();
  const state = normalizeWeeklyMissionState(snapshot.data(), currentWeek);
  return buildWeeklyMissionStatus(state);
});

export const claimWeeklyMission = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "weekly_mission_claim", 20, 60 * 1000);
  const data = request.data as { missionId?: unknown };
  const mission = weeklyMissions.find((item) => item.id === data.missionId);
  if (!mission) {
    throw new HttpsError("invalid-argument", "주간 미션 ID가 올바르지 않아요.");
  }
  const currentWeek = weekKey();

  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const missionRef = db.doc(`weeklyMissions/${uid}`);
    const missionSnapshot = await tx.get(missionRef);
    const missionState = normalizeWeeklyMissionState(missionSnapshot.data(), currentWeek);
    const progress = missionState.missions[mission.id] || { progress: 0, claimed: false };

    if (progress.claimed) {
      return {
        profile: publicProfile(profile),
        status: buildWeeklyMissionStatus(missionState),
        granted: false,
        rewards: { stars: 0 },
        message: "주간 미션 보상은 이미 받았어요.",
      };
    }

    if (progress.progress < mission.goal) {
      throw new HttpsError("failed-precondition", "아직 주간 미션을 완료하지 못했어요.");
    }

    const nextProfile = {
      ...profile,
      stars: clampInt(profile.stars + mission.rewardStars, profile.stars, 0, 99999999),
    };
    const nextState = {
      ...missionState,
      missions: {
        ...missionState.missions,
        [mission.id]: {
          progress: Math.max(progress.progress, mission.goal),
          claimed: true,
        },
      },
    };

    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(missionRef, weeklyMissionDoc(nextState), { merge: true });

    return {
      profile: publicProfile(nextProfile),
      status: buildWeeklyMissionStatus(nextState),
      granted: true,
      rewards: { stars: mission.rewardStars },
      message: `주간 미션 +${mission.rewardStars}별`,
    };
  });
});

export const getSeasonPassStatus = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const season = await getCurrentSeason();
  const [userSnapshot, passSnapshot] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`seasonPassClaims/${uid}`).get(),
  ]);
  const profile = recoverHearts(
    normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
  );
  const claims = normalizePassClaims(passSnapshot.data(), season.id);
  return buildSeasonPassStatus(profile, claims, season);
});

export const claimSeasonPassReward = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { level?: unknown; track?: unknown };
  const level = clampInt(data.level, 0, 1, passTiers.length);
  if (!isPassTrack(data.track)) {
    throw new HttpsError("invalid-argument", "패스 트랙이 올바르지 않아요.");
  }
  const track = data.track;
  const tier = passTiers.find((item) => item.level === level);
  if (!tier) throw new HttpsError("not-found", "패스 보상을 찾을 수 없어요.");

  const season = await getCurrentSeason();
  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const passRef = db.doc(`seasonPassClaims/${uid}`);
    const passSnapshot = await tx.get(passRef);
    const claims = normalizePassClaims(passSnapshot.data(), season.id);
    const currentLevel = passLevelFromXp(profile.xp);

    if (tier.level > currentLevel) {
      throw new HttpsError("failed-precondition", "아직 열리지 않은 패스 보상이에요.");
    }
    if (track === "premium" && !profile.seasonPassPremium) {
      throw new HttpsError("failed-precondition", "프리미엄 패스가 필요해요.");
    }
    if (claims[track].includes(tier.level)) {
      return {
        profile: publicProfile(profile),
        status: buildSeasonPassStatus(profile, claims, season),
        granted: false,
        rewards: tier[track],
        message: "이미 받은 패스 보상이에요.",
      };
    }

    const nextClaims = {
      ...claims,
      [track]: [...claims[track], tier.level].sort((a, b) => a - b),
    };
    const nextProfile = applyPassReward(profile, tier[track]);

    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      passRef,
      {
        ...nextClaims,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      profile: publicProfile(nextProfile),
      status: buildSeasonPassStatus(nextProfile, nextClaims, season),
      granted: true,
      rewards: tier[track],
      message: `${tier[track].label} 수령 완료`,
    };
  });
});

export const ensurePlayerProfile = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { nickname?: unknown };
  const accountPatch = await getAccountProviderPatch(uid);
  return runUserTransaction(uid, (profile, userRef, tx, exists) => {
    const nextProfile = {
      ...profile,
      nickname: sanitizeNickname(data.nickname || profile.nickname),
      ...accountPatch,
    };
    const createPatch = exists ? {} : { createdAt: FieldValue.serverTimestamp() };
    tx.set(
      userRef,
      {
        ...profileDoc(nextProfile),
        ...createPatch,
        lastLoginAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile) };
  });
});

export const getPlayerStats = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const userSnapshot = await db.doc(`users/${uid}`).get();
  const profile = recoverHearts(
    normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
  );
  return {
    profile: publicProfile(profile),
    stats: buildPlayerStats(profile),
  };
});

export const createRestoreCode = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const expiresAtMs = Date.now() + 10 * 60 * 1000;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = createRestoreCodeValue();
    const restoreRef = db.doc(`restoreCodes/${code}`);
    const snapshot = await restoreRef.get();
    const current = snapshot.data();
    const reusable =
      !snapshot.exists ||
      current?.consumed === true ||
      clampInt(current?.expiresAtMs, 0, 0, Number.MAX_SAFE_INTEGER) <= Date.now();

    if (!reusable) continue;

    await restoreRef.set({
      sourceUid: uid,
      expiresAtMs,
      consumed: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { code, expiresAtMs };
  }

  throw new HttpsError(
    "resource-exhausted",
    "복원 코드를 만들지 못했어요. 잠시 뒤 다시 시도해주세요.",
  );
});

export const restorePlayerProfile = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { code?: unknown };
  const code = sanitizeRestoreCode(data.code);
  const accountPatch = await getAccountProviderPatch(uid);

  return db.runTransaction(async (tx) => {
    const restoreRef = db.doc(`restoreCodes/${code}`);
    const restoreSnapshot = await tx.get(restoreRef);
    if (!restoreSnapshot.exists) {
      throw new HttpsError("not-found", "복원 코드를 찾을 수 없어요.");
    }

    const restoreDoc = restoreSnapshot.data() || {};
    if (restoreDoc.consumed === true) {
      throw new HttpsError("failed-precondition", "이미 사용된 복원 코드예요.");
    }
    if (clampInt(restoreDoc.expiresAtMs, 0, 0, Number.MAX_SAFE_INTEGER) <= Date.now()) {
      throw new HttpsError("deadline-exceeded", "복원 코드가 만료됐어요.");
    }

    const sourceUid = typeof restoreDoc.sourceUid === "string" ? restoreDoc.sourceUid : "";
    if (!sourceUid) throw new HttpsError("failed-precondition", "복원 코드가 올바르지 않아요.");

    const sourceRef = db.doc(`users/${sourceUid}`);
    const targetRef = db.doc(`users/${uid}`);
    const sourceSnapshot = await tx.get(sourceRef);
    if (!sourceSnapshot.exists) {
      throw new HttpsError("not-found", "복원할 프로필을 찾을 수 없어요.");
    }

    const sourceProfile = recoverHearts(normalizeProfile(sourceUid, sourceSnapshot.data()));
    const nextProfile = {
      ...sourceProfile,
      uid,
      ...accountPatch,
    };

    tx.set(
      targetRef,
      {
        ...profileDoc(nextProfile),
        lastLoginAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(
      restoreRef,
      {
        consumed: true,
        consumedBy: uid,
        consumedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { profile: publicProfile(nextProfile) };
  });
});

export const getFriendCode = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const byUidRef = db.doc(`friendCodesByUid/${uid}`);
  const current = await byUidRef.get();
  const currentCode = current.data()?.code;
  if (typeof currentCode === "string" && currentCode.length === 6) {
    return { code: currentCode };
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = createFriendCodeValue();
    const result = await db.runTransaction(async (tx) => {
      const latest = await tx.get(byUidRef);
      const latestCode = latest.data()?.code;
      if (typeof latestCode === "string" && latestCode.length === 6) return latestCode;

      const codeRef = db.doc(`friendCodes/${code}`);
      const codeSnapshot = await tx.get(codeRef);
      if (codeSnapshot.exists && codeSnapshot.data()?.uid !== uid) return null;

      tx.set(
        byUidRef,
        {
          code,
          uid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.set(
        codeRef,
        {
          uid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return code;
    });

    if (result) return { code: result };
  }

  throw new HttpsError("resource-exhausted", "친구 코드를 만들지 못했어요.");
});

export const getFriends = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const [snapshot, blockSnapshot] = await Promise.all([
    db.collection(`friends/${uid}/items`).limit(100).get(),
    db.collection(`userBlocks/${uid}/items`).limit(100).get(),
  ]);
  const blockedIds = new Set(blockSnapshot.docs.map((doc) => doc.id));
  const friendIds = snapshot.docs
    .map((doc) => doc.id)
    .filter((id, index, list) => id !== uid && !blockedIds.has(id) && list.indexOf(id) === index)
    .slice(0, 100);

  if (!friendIds.length) return { friends: [] as FriendEntry[] };

  const refs = friendIds.map((friendId) => db.doc(`users/${friendId}`));
  const profiles = await db.getAll(...refs);
  const friends = profiles
    .filter((profile) => profile.exists)
    .map((profile) => {
      const friendProfile = normalizeProfile(profile.id, profile.data());
      return publicFriendEntry(friendProfile, profile.data());
    });

  return { friends };
});

export const inviteFriend = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "friend_invite", 20, 60 * 1000);
  await assertNotBanned(uid);
  const data = request.data as { code?: unknown; userId?: unknown; requestOnly?: unknown };
  let friendUid = "";

  if (typeof data.userId === "string" && data.userId.trim()) {
    friendUid = sanitizeUid(data.userId.trim());
  } else {
    const code = sanitizeFriendCode(data.code);
    const codeSnapshot = await db.doc(`friendCodes/${code}`).get();
    friendUid = typeof codeSnapshot.data()?.uid === "string" ? codeSnapshot.data()?.uid : "";
  }

  if (!friendUid) throw new HttpsError("not-found", "친구 코드를 찾을 수 없어요.");
  if (friendUid === uid) throw new HttpsError("failed-precondition", "내 코드는 추가할 수 없어요.");
  await assertNoBlockBetween(uid, friendUid);

  return db.runTransaction(async (tx) => {
    const selfRef = db.doc(`users/${uid}`);
    const friendRef = db.doc(`users/${friendUid}`);
    const [selfSnapshot, friendSnapshot] = await Promise.all([tx.get(selfRef), tx.get(friendRef)]);
    if (!friendSnapshot.exists) throw new HttpsError("not-found", "친구 프로필을 찾을 수 없어요.");

    const selfProfile = normalizeProfile(
      uid,
      selfSnapshot.exists ? selfSnapshot.data() : undefined,
    );
    const friendProfile = normalizeProfile(friendUid, friendSnapshot.data());
    const selfFriendRef = db.doc(`friends/${uid}/items/${friendUid}`);
    const friendSelfRef = db.doc(`friends/${friendUid}/items/${uid}`);
    const requestRef = db.doc(`friendRequests/${friendUid}/items/${uid}`);
    const payload = {
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (data.requestOnly === true) {
      tx.set(
        requestRef,
        {
          fromUserId: uid,
          toUserId: friendUid,
          nickname: selfProfile.nickname,
          animal: selfProfile.mainCharacter,
          status: "pending",
          ...payload,
        },
        { merge: true },
      );
      return {
        pending: true,
        friend: publicFriendEntry(friendProfile, friendSnapshot.data()),
        self: publicFriendEntry(selfProfile, selfSnapshot.data()),
      };
    }

    tx.set(selfFriendRef, { ...payload, friendId: friendUid }, { merge: true });
    tx.set(friendSelfRef, { ...payload, friendId: uid }, { merge: true });
    tx.delete(requestRef);

    return {
      pending: false,
      friend: publicFriendEntry(friendProfile, friendSnapshot.data()),
      self: publicFriendEntry(selfProfile, selfSnapshot.data()),
    };
  });
});

export const acceptFriend = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "friend_accept", 30, 60 * 1000);
  await assertNotBanned(uid);
  const data = request.data as { friendId?: unknown };
  const friendUid = sanitizeUid(data.friendId);
  if (friendUid === uid) throw new HttpsError("failed-precondition", "내 계정은 추가할 수 없어요.");
  await assertNoBlockBetween(uid, friendUid);

  return db.runTransaction(async (tx) => {
    const selfRef = db.doc(`users/${uid}`);
    const friendRef = db.doc(`users/${friendUid}`);
    const requestRef = db.doc(`friendRequests/${uid}/items/${friendUid}`);
    const reverseRequestRef = db.doc(`friendRequests/${friendUid}/items/${uid}`);
    const [selfSnapshot, friendSnapshot] = await Promise.all([tx.get(selfRef), tx.get(friendRef)]);
    if (!friendSnapshot.exists) throw new HttpsError("not-found", "친구 프로필을 찾을 수 없어요.");

    const selfProfile = normalizeProfile(
      uid,
      selfSnapshot.exists ? selfSnapshot.data() : undefined,
    );
    const friendProfile = normalizeProfile(friendUid, friendSnapshot.data());
    const payload = {
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(
      db.doc(`friends/${uid}/items/${friendUid}`),
      { ...payload, friendId: friendUid },
      { merge: true },
    );
    tx.set(
      db.doc(`friends/${friendUid}/items/${uid}`),
      { ...payload, friendId: uid },
      { merge: true },
    );
    tx.delete(requestRef);
    tx.delete(reverseRequestRef);
    return {
      accepted: true,
      friend: publicFriendEntry(friendProfile, friendSnapshot.data()),
      self: publicFriendEntry(selfProfile, selfSnapshot.data()),
    };
  });
});

export const updateContactHashes = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "contacts_update", 8, 60 * 1000);
  const data = request.data as { contactHashes?: unknown; consent?: unknown };
  if (data.consent !== true) {
    await db.doc(`userContactHashes/${uid}`).delete();
    return { stored: false, count: 0 };
  }
  const hashes = sanitizeHashList(data.contactHashes);
  await db.doc(`userContactHashes/${uid}`).set(
    {
      userId: uid,
      hashes,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { stored: true, count: hashes.length };
});

export const getContactMatches = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "contacts_match", 20, 60 * 1000);
  const data = request.data as { contactHashes?: unknown; consent?: unknown };
  if (data.consent !== true) return { matches: [] as FriendEntry[] };
  const hashes = sanitizeHashList(data.contactHashes);
  if (!hashes.length) return { matches: [] as FriendEntry[] };

  const candidates = new Set<string>();
  for (let index = 0; index < hashes.length; index += 10) {
    const chunk = hashes.slice(index, index + 10);
    const snapshot = await db
      .collection("userContactHashes")
      .where("hashes", "array-contains-any", chunk)
      .limit(50)
      .get();
    snapshot.docs.forEach((doc) => {
      if (doc.id !== uid) candidates.add(doc.id);
    });
  }

  const candidateIds = [...candidates].slice(0, 50);
  if (!candidateIds.length) return { matches: [] as FriendEntry[] };
  const [blockSnapshot, friendSnapshot, ...profiles] = await Promise.all([
    db.collection(`userBlocks/${uid}/items`).limit(100).get(),
    db.collection(`friends/${uid}/items`).limit(100).get(),
    ...candidateIds.map((candidateUid) => db.doc(`users/${candidateUid}`).get()),
  ]);
  const blocked = new Set(blockSnapshot.docs.map((doc) => doc.id));
  const existingFriends = new Set(friendSnapshot.docs.map((doc) => doc.id));
  const matches = profiles
    .filter(
      (profile) => profile.exists && !blocked.has(profile.id) && !existingFriends.has(profile.id),
    )
    .map((profile) =>
      publicFriendEntry(normalizeProfile(profile.id, profile.data()), profile.data()),
    );
  return { matches };
});

export const getFriendRequests = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const snapshot = await db.collection(`friendRequests/${uid}/items`).limit(100).get();
  const requesterIds = snapshot.docs
    .map((doc) => doc.id)
    .filter((id, index, list) => id !== uid && list.indexOf(id) === index);
  if (!requesterIds.length) return { requests: [] as FriendEntry[] };
  const profiles = await db.getAll(...requesterIds.map((id) => db.doc(`users/${id}`)));
  return {
    requests: profiles
      .filter((profile) => profile.exists)
      .map((profile) =>
        publicFriendEntry(normalizeProfile(profile.id, profile.data()), profile.data()),
      ),
  };
});

export const removeFriend = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { friendId?: unknown };
  const friendId = sanitizeUid(data.friendId);
  if (friendId === uid) throw new HttpsError("failed-precondition", "내 계정은 삭제할 수 없어요.");

  await db.runTransaction(async (tx) => {
    tx.delete(db.doc(`friends/${uid}/items/${friendId}`));
    tx.delete(db.doc(`friends/${friendId}/items/${uid}`));
  });

  return { removed: true, friendId };
});

export const blockUser = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "moderation_block", 30, 60 * 1000);
  const data = request.data as { userId?: unknown; reason?: unknown };
  const targetUid = sanitizeUid(data.userId);
  if (targetUid === uid) throw new HttpsError("failed-precondition", "내 계정은 차단할 수 없어요.");

  await db.runTransaction(async (tx) => {
    const targetRef = db.doc(`users/${targetUid}`);
    const targetSnapshot = await tx.get(targetRef);
    if (!targetSnapshot.exists) throw new HttpsError("not-found", "유저를 찾을 수 없어요.");
    tx.set(
      db.doc(`userBlocks/${uid}/items/${targetUid}`),
      {
        userId: uid,
        blockedUserId: targetUid,
        reason: sanitizeOptionalText(data.reason, 120),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.delete(db.doc(`friends/${uid}/items/${targetUid}`));
    tx.delete(db.doc(`friends/${targetUid}/items/${uid}`));
    tx.delete(db.doc(`friendRequests/${uid}/items/${targetUid}`));
    tx.delete(db.doc(`friendRequests/${targetUid}/items/${uid}`));
  });

  return { blocked: true, userId: targetUid };
});

export const unblockUser = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { userId?: unknown };
  const targetUid = sanitizeUid(data.userId);
  await db.doc(`userBlocks/${uid}/items/${targetUid}`).delete();
  return { blocked: false, userId: targetUid };
});

export const getBlockedUsers = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const snapshot = await db.collection(`userBlocks/${uid}/items`).limit(100).get();
  const ids = snapshot.docs.map((doc) => doc.id).filter((id) => id !== uid);
  if (!ids.length) return { blockedUsers: [] };
  const profiles = await db.getAll(...ids.map((id) => db.doc(`users/${id}`)));
  return {
    blockedUsers: profiles.map((profile) => ({
      userId: profile.id,
      profile: profile.exists
        ? publicFriendEntry(normalizeProfile(profile.id, profile.data()), profile.data())
        : null,
      blockedAt: timestampToIso(
        snapshot.docs.find((doc) => doc.id === profile.id)?.data().createdAt,
      ),
    })),
  };
});

export const reportPlayer = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "moderation_report", 10, 5 * 60 * 1000);
  const data = request.data as {
    userId?: unknown;
    reason?: unknown;
    details?: unknown;
    matchId?: unknown;
  };
  const targetUid = sanitizeUid(data.userId);
  if (targetUid === uid) throw new HttpsError("failed-precondition", "내 계정은 신고할 수 없어요.");
  const reason = sanitizeReportReason(data.reason);
  const details = sanitizeOptionalText(data.details, 500);
  const matchId =
    typeof data.matchId === "string" && /^[A-Za-z0-9:_-]{8,120}$/.test(data.matchId)
      ? data.matchId
      : "";
  const reportId = `${uid}_${targetUid}_${Date.now()}_${randomBytes(4).toString("hex")}`;

  await db.runTransaction(async (tx) => {
    const targetSnapshot = await tx.get(db.doc(`users/${targetUid}`));
    if (!targetSnapshot.exists) throw new HttpsError("not-found", "신고할 유저를 찾을 수 없어요.");
    tx.set(db.doc(`reports/${reportId}`), {
      reporterId: uid,
      targetUserId: targetUid,
      reason,
      details,
      matchId,
      status: "open",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (matchId) {
      tx.set(
        db.doc(`matches/${matchId}`),
        { reportCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
  });

  return { reported: true, reportId };
});

export const getModerationStatus = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const snapshot = await db.doc(`moderationBans/${uid}`).get();
  const raw = snapshot.data() || {};
  const expiresAtMs = timestampToMillis(raw.expiresAt);
  const banned = raw.active === true && (!expiresAtMs || expiresAtMs > Date.now());
  return {
    banned,
    reason: banned && typeof raw.reason === "string" ? raw.reason.slice(0, 120) : "",
    expiresAt: banned ? timestampToIso(raw.expiresAt) : null,
  };
});

export const getGuild = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const userGuildSnapshot = await db.doc(`userGuilds/${uid}`).get();
  const guildId = userGuildSnapshot.exists ? userGuildSnapshot.data()?.guildId : "";
  if (typeof guildId !== "string" || !guildId) {
    return { guild: null, members: [], boss: null };
  }

  const guildSnapshot = await db.doc(`guilds/${guildId}`).get();
  if (!guildSnapshot.exists) return { guild: null, members: [], boss: null };

  const membersSnapshot = await db
    .collection(`guildMembers/${guildId}/items`)
    .orderBy("weeklyContribution", "desc")
    .limit(30)
    .get();
  const guild = publicGuild(guildId, guildSnapshot.data());
  return {
    guild,
    boss: guild.boss,
    members: membersSnapshot.docs.map((doc) => publicGuildMember(doc.id, doc.data())),
  };
});

export const createGuild = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "guild_create", 5, 60 * 1000);
  await assertNotBanned(uid);
  const data = request.data as { name?: unknown; description?: unknown };
  const name = sanitizeGuildName(data.name);
  const description = sanitizeGuildDescription(data.description);
  const guildId = createGuildId();

  return db.runTransaction(async (tx) => {
    const userGuildRef = db.doc(`userGuilds/${uid}`);
    const userRef = db.doc(`users/${uid}`);
    const guildRef = db.doc(`guilds/${guildId}`);
    const memberRef = db.doc(`guildMembers/${guildId}/items/${uid}`);
    const [userGuildSnapshot, userSnapshot] = await Promise.all([
      tx.get(userGuildRef),
      tx.get(userRef),
    ]);
    if (userGuildSnapshot.exists) {
      throw new HttpsError("already-exists", "이미 가입한 길드가 있어요.");
    }
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const boss = currentGuildBoss(undefined, 1);
    const guildDoc = {
      name,
      description,
      ownerId: uid,
      level: 1,
      memberCount: 1,
      weeklyScore: 0,
      rank: 0,
      boss,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const memberDoc = {
      guildId,
      userId: uid,
      nickname: profile.nickname,
      animal: profile.mainCharacter,
      role: "leader",
      weeklyContribution: 0,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(guildRef, guildDoc);
    tx.set(memberRef, memberDoc);
    tx.set(userGuildRef, {
      guildId,
      role: "leader",
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      guild: publicGuild(guildId, guildDoc),
      boss,
      members: [publicGuildMember(uid, memberDoc, profile)],
    };
  });
});

export const joinGuild = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "guild_join", 10, 60 * 1000);
  await assertNotBanned(uid);
  const data = request.data as { guildId?: unknown };
  const guildId = sanitizeGuildId(data.guildId);

  return db.runTransaction(async (tx) => {
    const userGuildRef = db.doc(`userGuilds/${uid}`);
    const userRef = db.doc(`users/${uid}`);
    const guildRef = db.doc(`guilds/${guildId}`);
    const memberRef = db.doc(`guildMembers/${guildId}/items/${uid}`);
    const [userGuildSnapshot, userSnapshot, guildSnapshot] = await Promise.all([
      tx.get(userGuildRef),
      tx.get(userRef),
      tx.get(guildRef),
    ]);
    if (userGuildSnapshot.exists) {
      throw new HttpsError("already-exists", "이미 가입한 길드가 있어요.");
    }
    if (!guildSnapshot.exists) throw new HttpsError("not-found", "길드를 찾을 수 없어요.");

    const guild = publicGuild(guildId, guildSnapshot.data());
    if (guild.memberCount >= 30) {
      throw new HttpsError("resource-exhausted", "길드 정원이 가득 찼어요.");
    }
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const memberDoc = {
      guildId,
      userId: uid,
      nickname: profile.nickname,
      animal: profile.mainCharacter,
      role: "member",
      weeklyContribution: 0,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(memberRef, memberDoc);
    tx.set(userGuildRef, {
      guildId,
      role: "member",
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      guildRef,
      { memberCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return {
      guild: { ...guild, memberCount: guild.memberCount + 1 },
      boss: guild.boss,
      members: [publicGuildMember(uid, memberDoc, profile)],
    };
  });
});

export const leaveGuild = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);

  await db.runTransaction(async (tx) => {
    const userGuildRef = db.doc(`userGuilds/${uid}`);
    const userGuildSnapshot = await tx.get(userGuildRef);
    const guildId = userGuildSnapshot.exists ? userGuildSnapshot.data()?.guildId : "";
    if (typeof guildId !== "string" || !guildId) {
      throw new HttpsError("not-found", "가입한 길드가 없어요.");
    }
    const guildRef = db.doc(`guilds/${guildId}`);
    const memberRef = db.doc(`guildMembers/${guildId}/items/${uid}`);
    const guildSnapshot = await tx.get(guildRef);
    const guild = publicGuild(guildId, guildSnapshot.data());
    if (guild.ownerId === uid && guild.memberCount > 1) {
      throw new HttpsError("failed-precondition", "길드장은 멤버가 남아 있으면 나갈 수 없어요.");
    }

    tx.delete(userGuildRef);
    tx.delete(memberRef);
    if (guild.ownerId === uid) {
      tx.delete(guildRef);
    } else {
      tx.set(
        guildRef,
        {
          memberCount: FieldValue.increment(-1),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  });

  return { guild: null, members: [], boss: null };
});

export const kickGuildMember = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "guild_kick", 10, 60 * 1000);
  await assertNotBanned(uid);
  const data = request.data as { userId?: unknown };
  const targetUid = sanitizeUid(data.userId);
  if (targetUid === uid) {
    throw new HttpsError("failed-precondition", "길드장은 내보내기 대신 나가기를 사용해주세요.");
  }

  let guildId = "";
  await db.runTransaction(async (tx) => {
    const ownerGuildRef = db.doc(`userGuilds/${uid}`);
    const ownerGuildSnapshot = await tx.get(ownerGuildRef);
    guildId = ownerGuildSnapshot.exists ? ownerGuildSnapshot.data()?.guildId : "";
    if (typeof guildId !== "string" || !guildId) {
      throw new HttpsError("not-found", "가입한 길드가 없어요.");
    }

    const guildRef = db.doc(`guilds/${guildId}`);
    const targetGuildRef = db.doc(`userGuilds/${targetUid}`);
    const targetMemberRef = db.doc(`guildMembers/${guildId}/items/${targetUid}`);
    const [guildSnapshot, targetGuildSnapshot, targetMemberSnapshot] = await Promise.all([
      tx.get(guildRef),
      tx.get(targetGuildRef),
      tx.get(targetMemberRef),
    ]);
    if (!guildSnapshot.exists) throw new HttpsError("not-found", "길드를 찾을 수 없어요.");

    const guild = publicGuild(guildId, guildSnapshot.data());
    if (guild.ownerId !== uid) {
      throw new HttpsError("permission-denied", "길드장만 멤버를 내보낼 수 있어요.");
    }
    if (!targetMemberSnapshot.exists || targetGuildSnapshot.data()?.guildId !== guildId) {
      throw new HttpsError("not-found", "길드 멤버를 찾을 수 없어요.");
    }

    tx.delete(targetGuildRef);
    tx.delete(targetMemberRef);
    tx.set(
      guildRef,
      {
        memberCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return { removed: true, guildId, userId: targetUid };
});

export const hitGuildBoss = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertNotBanned(uid);
  const data = request.data as { matchId?: unknown };
  if (typeof data.matchId !== "string") {
    throw new HttpsError("invalid-argument", "matchId가 필요해요.");
  }

  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const matchRef = db.doc(`matches/${data.matchId}`);
    const [userSnapshot, matchSnapshot] = await Promise.all([tx.get(userRef), tx.get(matchRef)]);
    if (!matchSnapshot.exists) throw new HttpsError("not-found", "매치 세션을 찾을 수 없어요.");
    const match = matchSnapshot.data() || {};
    if (match.userId !== uid) throw new HttpsError("permission-denied", "다른 계정의 매치예요.");
    if (match.status !== "finished" || match.accepted !== true) {
      throw new HttpsError("failed-precondition", "검증된 매치만 길드 보스에 반영돼요.");
    }
    if (match.guildClaimed === true) {
      throw new HttpsError("already-exists", "이미 길드 보스에 반영된 매치예요.");
    }

    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const contribution = await applyGuildContribution(
      tx,
      uid,
      profile,
      clampInt(match.score, 0, 0, 9999999),
    );
    if (!contribution) throw new HttpsError("not-found", "가입한 길드가 없어요.");
    tx.set(
      matchRef,
      {
        guildClaimed: true,
        guildDamage: contribution.damage,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return contribution;
  });
});

export const getLiveOpsConfig = onCall(async (request) => {
  const uid = request.auth?.uid || "anonymous";
  const [seasonSnapshot, shopSnapshot, bannerSnapshot, experimentSnapshot] = await Promise.all([
    db.doc("liveConfig/seasonCurrent").get(),
    db.doc("liveConfig/shopItems").get(),
    db.doc("liveConfig/eventBanners").get(),
    db.doc("liveConfig/experiments").get(),
  ]);
  const season = seasonSnapshot.exists
    ? { ...fallbackSeason, ...(exportValue(seasonSnapshot.data() || {}) as object) }
    : fallbackSeason;
  const rawShopItems = shopSnapshot.exists ? shopSnapshot.data()?.items : null;
  const rawBanners = bannerSnapshot.exists ? bannerSnapshot.data()?.items : null;
  const experimentDoc = experimentSnapshot.exists
    ? (experimentSnapshot.data() as Record<string, unknown>)
    : {};
  const experiments = EXPERIMENT_KEYS.reduce<Record<string, string>>((result, key) => {
    const variants = Array.isArray(experimentDoc[key])
      ? (experimentDoc[key] as unknown[]).filter((item): item is string => typeof item === "string")
      : fallbackExperiments[key];
    result[key] = stableVariant(uid, key, variants);
    return result;
  }, {});

  return {
    season,
    shopItems: Array.isArray(rawShopItems) ? rawShopItems.slice(0, 60) : fallbackShopItems,
    eventBanners: Array.isArray(rawBanners) ? rawBanners.slice(0, 12) : [],
    experiments,
    fetchedAt: new Date().toISOString(),
  };
});

export const getSeasonCurrent = onCall(async () => {
  const season = await getCurrentSeason();
  return { season };
});

export const getShopItems = onCall(async () => {
  const snapshot = await db.doc("liveConfig/shopItems").get();
  const items =
    snapshot.exists && Array.isArray(snapshot.data()?.items)
      ? (snapshot.data()?.items as ShopItem[]).slice(0, 60)
      : fallbackShopItems;
  return { items };
});

export const getNotificationPreferences = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const snapshot = await db.doc(`notificationPrefs/${uid}`).get();
  const raw = snapshot.data() || {};
  const topics = normalizeNotificationTopics(raw.topics);
  return {
    pushEnabled: raw.pushEnabled !== false,
    topics: topics.length
      ? topics
      : (["heart_full", "daily_reminder"] satisfies NotificationTopic[]),
  };
});

export const updateNotificationTopics = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { pushEnabled?: unknown; topics?: unknown };
  const topics = normalizeNotificationTopics(data.topics);
  const pushEnabled = data.pushEnabled !== false;
  await db.doc(`notificationPrefs/${uid}`).set(
    {
      pushEnabled,
      topics,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { pushEnabled, topics };
});

export const registerNotificationToken = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { token?: unknown; platform?: unknown; topics?: unknown };
  if (typeof data.token !== "string" || data.token.length < 16 || data.token.length > 4096) {
    throw new HttpsError("invalid-argument", "푸시 토큰이 올바르지 않아요.");
  }
  if (!isNotificationPlatform(data.platform)) {
    throw new HttpsError("invalid-argument", "푸시 플랫폼이 올바르지 않아요.");
  }
  const topics = normalizeNotificationTopics(data.topics);
  const tokenHash = sha256(data.token);
  await db.doc(`notificationTokens/${uid}_${tokenHash.slice(0, 28)}`).set(
    {
      userId: uid,
      tokenHash,
      token: data.token,
      platform: data.platform,
      topics,
      active: true,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { registered: true, topics };
});

export const sendPushCampaign = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  assertLiveOpsAdmin(uid);
  await assertRateLimit(uid, "push_campaign", 10, 60 * 1000);
  const data = request.data as {
    topic?: unknown;
    title?: unknown;
    body?: unknown;
    dryRun?: unknown;
  };
  if (!isNotificationTopic(data.topic)) {
    throw new HttpsError("invalid-argument", "푸시 토픽이 올바르지 않아요.");
  }
  const title = sanitizeOptionalText(data.title, 80);
  const body = sanitizeOptionalText(data.body, 180);
  if (!title || !body) {
    throw new HttpsError("invalid-argument", "푸시 제목과 본문이 필요해요.");
  }

  const campaignRef = db.collection("pushCampaigns").doc();
  const tokenSnapshot = await db
    .collection("notificationTokens")
    .where("active", "==", true)
    .where("topics", "array-contains", data.topic)
    .limit(500)
    .get();
  const tokens = tokenSnapshot.docs
    .map((doc) => doc.data().token)
    .filter((token): token is string => typeof token === "string" && token.length >= 16);

  let successCount = 0;
  let failureCount = 0;
  if (data.dryRun !== true && tokens.length) {
    for (let index = 0; index < tokens.length; index += 500) {
      const response = await getMessaging().sendEachForMulticast({
        tokens: tokens.slice(index, index + 500),
        notification: { title, body },
        data: { topic: data.topic, campaignId: campaignRef.id },
      });
      successCount += response.successCount;
      failureCount += response.failureCount;
    }
  }

  await campaignRef.set({
    topic: data.topic,
    title,
    body,
    dryRun: data.dryRun === true,
    targetedTokens: tokens.length,
    successCount,
    failureCount,
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    campaignId: campaignRef.id,
    targetedTokens: tokens.length,
    successCount,
    failureCount,
    dryRun: data.dryRun === true,
  };
});

export const claimAdReward = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "ad_reward", 12, 60 * 1000);
  const data = request.data as {
    rewardType?: unknown;
    rewardId?: unknown;
    adNetwork?: unknown;
    signature?: unknown;
    timestamp?: unknown;
    nonce?: unknown;
  };
  if (!isAdRewardType(data.rewardType)) {
    throw new HttpsError("invalid-argument", "광고 보상 종류가 올바르지 않아요.");
  }
  const today = dayKey();
  const rewardId =
    typeof data.rewardId === "string" && data.rewardId.length <= 80
      ? data.rewardId.replace(/[^A-Za-z0-9:_-]/g, "")
      : `${today}_${randomBytes(6).toString("hex")}`;
  const verification = verifyAdRewardSignature({
    uid,
    rewardId,
    rewardType: data.rewardType,
    adNetwork: data.adNetwork,
    signature: data.signature,
    timestamp: data.timestamp,
    nonce: data.nonce,
  });

  return grantAdReward({
    uid,
    rewardId,
    rewardType: data.rewardType,
    verification,
  });
});

export const logTelemetryEvent = onCall(async (request) => {
  const data = request.data as { name?: unknown; payload?: unknown };
  if (!isTelemetryEventName(data.name)) {
    throw new HttpsError("invalid-argument", "이벤트 이름이 올바르지 않아요.");
  }
  await db.collection("telemetryEvents").add({
    userId: request.auth?.uid || null,
    name: data.name,
    payload: sanitizeTelemetryPayload(data.payload),
    createdAt: FieldValue.serverTimestamp(),
  });
  return { logged: true };
});

export const exportPlayerData = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  await assertRateLimit(uid, "data_export", 6, 60 * 1000);

  const [
    userSnapshot,
    dailyCheckinSnapshot,
    dailyMissionSnapshot,
    weeklyMissionSnapshot,
    stageProgressSnapshot,
    passClaimsSnapshot,
    friendCodeSnapshot,
    friendsSnapshot,
    friendRequestsSnapshot,
    contactHashesSnapshot,
    blocksSnapshot,
    scoresSnapshot,
    matchesSnapshot,
    versusSnapshot,
    iapSnapshot,
    seasonRewardsSnapshot,
    userGuildSnapshot,
    notificationPrefsSnapshot,
    notificationTokensSnapshot,
    reportsByMeSnapshot,
    reportsAboutMeSnapshot,
  ] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`dailyCheckins/${uid}`).get(),
    db.doc(`dailyMissions/${uid}`).get(),
    db.doc(`weeklyMissions/${uid}`).get(),
    db.doc(`stageProgress/${uid}`).get(),
    db.doc(`seasonPassClaims/${uid}`).get(),
    db.doc(`friendCodesByUid/${uid}`).get(),
    db.collection(`friends/${uid}/items`).limit(100).get(),
    db.collection(`friendRequests/${uid}/items`).limit(100).get(),
    db.doc(`userContactHashes/${uid}`).get(),
    db.collection(`userBlocks/${uid}/items`).limit(100).get(),
    db.collection("scores").where("playerUid", "==", uid).limit(200).get(),
    db.collection("matches").where("userId", "==", uid).limit(200).get(),
    db.collection("versusMatches").where("userId", "==", uid).limit(200).get(),
    db.collection("iapTransactions").where("userId", "==", uid).limit(100).get(),
    db.collection("seasonRewards").where("userId", "==", uid).limit(100).get(),
    db.doc(`userGuilds/${uid}`).get(),
    db.doc(`notificationPrefs/${uid}`).get(),
    db.collection("notificationTokens").where("userId", "==", uid).limit(100).get(),
    db.collection("reports").where("reporterId", "==", uid).limit(100).get(),
    db.collection("reports").where("targetUserId", "==", uid).limit(100).get(),
  ]);

  const guildId = userGuildSnapshot.exists ? userGuildSnapshot.data()?.guildId : "";
  const guildMemberSnapshot =
    typeof guildId === "string" && guildId
      ? await db.doc(`guildMembers/${guildId}/items/${uid}`).get()
      : null;

  return {
    exportedAt: new Date().toISOString(),
    uid,
    profile: exportDoc(userSnapshot),
    stats: userSnapshot.exists
      ? buildPlayerStats(recoverHearts(normalizeProfile(uid, userSnapshot.data())))
      : null,
    progress: {
      dailyCheckin: exportDoc(dailyCheckinSnapshot),
      dailyMission: exportDoc(dailyMissionSnapshot),
      weeklyMission: exportDoc(weeklyMissionSnapshot),
      stageProgress: exportDoc(stageProgressSnapshot),
      seasonPassClaims: exportDoc(passClaimsSnapshot),
    },
    social: {
      friendCode: exportDoc(friendCodeSnapshot),
      friends: exportDocs(friendsSnapshot),
      friendRequests: exportDocs(friendRequestsSnapshot),
      contactHashes: exportDoc(contactHashesSnapshot),
      blockedUsers: exportDocs(blocksSnapshot),
      guild: exportDoc(userGuildSnapshot),
      guildMember: guildMemberSnapshot ? exportDoc(guildMemberSnapshot) : null,
    },
    gameplay: {
      scores: exportDocs(scoresSnapshot),
      matches: exportDocs(matchesSnapshot),
      versusMatches: exportDocs(versusSnapshot),
    },
    commerce: {
      iapTransactions: exportDocs(iapSnapshot),
      seasonRewards: exportDocs(seasonRewardsSnapshot),
    },
    notifications: {
      preferences: exportDoc(notificationPrefsSnapshot),
      tokens: notificationTokensSnapshot.docs.map((doc) => {
        const { token, ...safeData } = doc.data();
        void token;
        return { id: doc.id, data: exportValue(safeData) };
      }),
    },
    moderation: {
      reportsByMe: exportDocs(reportsByMeSnapshot),
      reportsAboutMe: exportDocs(reportsAboutMeSnapshot),
    },
  };
});

async function deletePlayerAccountData(uid: string) {
  const refs: FirebaseFirestore.DocumentReference[] = [
    db.doc(`users/${uid}`),
    db.doc(`dailyCheckins/${uid}`),
    db.doc(`dailyMissions/${uid}`),
    db.doc(`weeklyMissions/${uid}`),
    db.doc(`stageProgress/${uid}`),
    db.doc(`seasonPassClaims/${uid}`),
    db.doc(`friendCodesByUid/${uid}`),
    db.doc(`userContactHashes/${uid}`),
    db.doc(`notificationPrefs/${uid}`),
    db.doc(`moderationBans/${uid}`),
  ];

  const [
    friendCodeSnapshot,
    friendsSnapshot,
    friendRequestsSnapshot,
    ownBlocksSnapshot,
    reverseBlocksSnapshot,
    matchesSnapshot,
    versusMatchesSnapshot,
    scoresSnapshot,
    iapSnapshot,
    seasonRewardsSnapshot,
    authRefreshTokensSnapshot,
    notificationTokensSnapshot,
    adRewardsSnapshot,
    adRewardCountersSnapshot,
    reportsByMeSnapshot,
    reportsAboutMeSnapshot,
    userGuildSnapshot,
  ] = await Promise.all([
    db.doc(`friendCodesByUid/${uid}`).get(),
    db.collection(`friends/${uid}/items`).limit(400).get(),
    db.collection(`friendRequests/${uid}/items`).limit(400).get(),
    db.collection(`userBlocks/${uid}/items`).limit(400).get(),
    db.collectionGroup("items").where("blockedUserId", "==", uid).limit(400).get(),
    db.collection("matches").where("userId", "==", uid).limit(400).get(),
    db.collection("versusMatches").where("userId", "==", uid).limit(400).get(),
    db.collection("scores").where("playerUid", "==", uid).limit(400).get(),
    db.collection("iapTransactions").where("userId", "==", uid).limit(100).get(),
    db.collection("seasonRewards").where("userId", "==", uid).limit(100).get(),
    db.collection("authRefreshTokens").where("uid", "==", uid).limit(400).get(),
    db.collection("notificationTokens").where("userId", "==", uid).limit(100).get(),
    db.collection("adRewards").where("userId", "==", uid).limit(200).get(),
    db.collection("adRewardCounters").where("userId", "==", uid).limit(50).get(),
    db.collection("reports").where("reporterId", "==", uid).limit(100).get(),
    db.collection("reports").where("targetUserId", "==", uid).limit(100).get(),
    db.doc(`userGuilds/${uid}`).get(),
  ]);

  const friendCode = friendCodeSnapshot.data()?.code;
  if (typeof friendCode === "string") refs.push(db.doc(`friendCodes/${friendCode}`));

  friendsSnapshot.docs.forEach((friendDoc) => {
    refs.push(friendDoc.ref);
    refs.push(db.doc(`friends/${friendDoc.id}/items/${uid}`));
  });
  friendRequestsSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  ownBlocksSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  reverseBlocksSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  matchesSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  versusMatchesSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  scoresSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  iapSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  seasonRewardsSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  authRefreshTokensSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  notificationTokensSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  adRewardsSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  adRewardCountersSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  reportsByMeSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  reportsAboutMeSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  if (userGuildSnapshot.exists) {
    const guildId = userGuildSnapshot.data()?.guildId;
    refs.push(userGuildSnapshot.ref);
    if (typeof guildId === "string" && guildId) {
      refs.push(db.doc(`guildMembers/${guildId}/items/${uid}`));
    }
  }

  const [restoreSourceSnapshot, restoreConsumedSnapshot] = await Promise.all([
    db.collection("restoreCodes").where("sourceUid", "==", uid).limit(50).get(),
    db.collection("restoreCodes").where("consumedBy", "==", uid).limit(50).get(),
  ]);
  restoreSourceSnapshot.docs.forEach((doc) => refs.push(doc.ref));
  restoreConsumedSnapshot.docs.forEach((doc) => refs.push(doc.ref));

  await deleteDocumentRefs(refs);
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "auth/user-not-found") throw error;
  }

  return { deleted: true };
}

export const deletePlayerAccount = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  return deletePlayerAccountData(uid);
});

export const syncAccountProviders = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { nickname?: unknown };
  const accountPatch = await getAccountProviderPatch(uid);
  return runUserTransaction(uid, (profile, userRef, tx) => {
    const nextProfile = {
      ...profile,
      nickname: sanitizeNickname(data.nickname || profile.nickname),
      ...accountPatch,
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile) };
  });
});

export const getStageProgress = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const snapshot = await db.doc(`stageProgress/${uid}`).get();
  return { progress: normalizeStageProgress(snapshot.data()) };
});

export const clearStage = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { stageId?: unknown; stars?: unknown };
  const stageId = clampInt(data.stageId, 1, 1, 12);
  const earnedStars = clampInt(data.stars, 0, 0, 3);
  if (earnedStars <= 0) throw new HttpsError("failed-precondition", "저장할 별이 없어요.");

  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const progressRef = db.doc(`stageProgress/${uid}`);
    const progressSnapshot = await tx.get(progressRef);
    const raw = progressSnapshot.data() || {};
    const stars = (raw.stars || {}) as Record<string, number>;
    const key = String(stageId);
    const previousStars = clampInt(stars[key], 0, 0, 3);
    const nextStarsForStage = Math.max(previousStars, earnedStars);
    const rewardStars = Math.max(0, nextStarsForStage - previousStars) * 25;
    const currentStage = clampInt(raw.currentStage, 1, 1, 12);
    const nextProgress = {
      chapter: typeof raw.chapter === "string" ? raw.chapter : "ch1",
      currentStage: stageId >= currentStage ? Math.min(12, stageId + 1) : currentStage,
      stars: { ...stars, [key]: nextStarsForStage },
    };
    const nextProfile = { ...profile, stars: profile.stars + rewardStars };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      progressRef,
      { ...nextProgress, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return {
      profile: publicProfile(nextProfile),
      progress: nextProgress,
      rewards: { stars: rewardStars },
    };
  });
});

export const purchaseShopItem = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { itemId?: unknown };
  if (typeof data.itemId !== "string")
    throw new HttpsError("invalid-argument", "상품 ID가 필요해요.");
  const item = await getShopItem(data.itemId);
  if (!item) throw new HttpsError("not-found", "상품을 찾을 수 없어요.");
  if (item.currency !== "stars") {
    throw new HttpsError(
      "failed-precondition",
      "결제 상품은 스토어 검증 연결 후 사용할 수 있어요.",
    );
  }

  return runUserTransaction(uid, (profile, userRef, tx) => {
    if (profile.stars < item.price) {
      throw new HttpsError("failed-precondition", `별 ${item.price}개가 필요해요.`);
    }

    let nextProfile: PlayerProfile | null = null;
    if (item.category === "hearts") {
      const quantity = item.id.includes("5") ? 5 : 1;
      const hearts = Math.min(MAX_HEARTS, profile.hearts + quantity);
      if (hearts === profile.hearts) {
        throw new HttpsError("failed-precondition", "하트가 이미 가득 찼어요.");
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
      const quantity = clampInt(item.id.match(/\d+/)?.[0], 1, 1, 99);
      nextProfile = {
        ...profile,
        stars: profile.stars - item.price,
        inventory: {
          ...profile.inventory,
          [key]: clampInt(profile.inventory[key], 0, 0, 999) + quantity,
        },
      };
    }

    if (!nextProfile) throw new HttpsError("failed-precondition", "아직 준비 중인 상품이에요.");
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return {
      profile: publicProfile(nextProfile),
      purchased: true,
      message: `${item.name} 구매 완료`,
    };
  });
});

export const verifyIapPurchase = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as {
    platform?: unknown;
    productId?: unknown;
    purchaseToken?: unknown;
    transactionId?: unknown;
  };

  if (!isIapPlatform(data.platform)) {
    throw new HttpsError("invalid-argument", "스토어 플랫폼이 올바르지 않아요.");
  }
  if (typeof data.productId !== "string" || data.productId.length > 120) {
    throw new HttpsError("invalid-argument", "상품 ID가 필요해요.");
  }

  const item = await getIapShopItem(data.productId);
  const grant = iapGrants[data.productId];
  if (!item || !grant) {
    throw new HttpsError("not-found", "검증 가능한 결제 상품이 아니에요.");
  }

  const verified = await verifyIapWithStore({
    platform: data.platform,
    productId: data.productId,
    purchaseToken: data.purchaseToken,
    transactionId: data.transactionId,
  });
  const transactionRef = db.doc(
    `iapTransactions/${verified.platform}_${sha256(verified.transactionId)}`,
  );

  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const [userSnapshot, transactionSnapshot] = await Promise.all([
      tx.get(userRef),
      tx.get(transactionRef),
    ]);
    const profile = recoverHearts(
      normalizeProfile(uid, userSnapshot.exists ? userSnapshot.data() : undefined),
    );
    const rewards = summarizeIapGrant(grant, verified.quantity);

    if (transactionSnapshot.exists) {
      const existing = transactionSnapshot.data();
      if (existing?.userId !== uid) {
        throw new HttpsError("already-exists", "이미 다른 계정에 지급된 결제예요.");
      }
      return {
        profile: publicProfile(profile),
        granted: false,
        alreadyGranted: true,
        item,
        rewards,
      };
    }

    const nextProfile = applyIapGrant(profile, grant, verified.quantity);
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(transactionRef, {
      userId: uid,
      platform: verified.platform,
      productId: verified.productId,
      itemId: item.id,
      transactionId: verified.transactionId,
      orderId: verified.orderId || null,
      tokenHash: verified.tokenHash || null,
      quantity: verified.quantity,
      environment: verified.environment,
      rewards,
      grantedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      profile: publicProfile(nextProfile),
      granted: true,
      alreadyGranted: false,
      item,
      rewards,
    };
  });
});

export const getCharacterDex = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const snapshot = await db.doc(`users/${uid}`).get();
  const profile = recoverHearts(
    normalizeProfile(uid, snapshot.exists ? snapshot.data() : undefined),
  );
  return { characters: buildCharacterDex(profile) };
});

export const setMainCharacter = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { animal?: unknown };
  if (!isCharacterId(data.animal))
    throw new HttpsError("invalid-argument", "캐릭터가 올바르지 않아요.");

  return runUserTransaction(uid, (profile, userRef, tx) => {
    if (!profile.unlockedCharacters.includes(data.animal as CharacterId)) {
      throw new HttpsError("failed-precondition", "아직 잠긴 캐릭터예요.");
    }
    const nextProfile = { ...profile, mainCharacter: data.animal as CharacterId };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile) };
  });
});

export const levelUpCharacter = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { animal?: unknown };
  if (!isCharacterId(data.animal))
    throw new HttpsError("invalid-argument", "캐릭터가 올바르지 않아요.");
  const animal = data.animal;

  return runUserTransaction(uid, (profile, userRef, tx) => {
    if (!profile.unlockedCharacters.includes(animal)) {
      throw new HttpsError("failed-precondition", "아직 잠긴 캐릭터예요.");
    }
    const currentLevel = profile.characterLevels[animal] || 1;
    const cost = currentLevel * 80;
    if (profile.stars < cost) {
      return { profile: publicProfile(profile), leveled: false, cost };
    }
    const nextProfile = {
      ...profile,
      stars: profile.stars - cost,
      characterLevels: {
        ...profile.characterLevels,
        [animal]: currentLevel + 1,
      },
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile), leveled: true, cost };
  });
});

export const spendHeart = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  return runUserTransaction(uid, (profile, userRef, tx) => {
    if (profile.hearts <= 0) {
      tx.set(
        userRef,
        { ...profileDoc(profile), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return { spent: false, profile: publicProfile(profile) };
    }

    const nextProfile = {
      ...profile,
      hearts: profile.hearts - 1,
      lastHeartAt: profile.hearts >= MAX_HEARTS ? Date.now() : profile.lastHeartAt,
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { spent: true, profile: publicProfile(nextProfile) };
  });
});

export const claimHeartTimer = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  return runUserTransaction(uid, (profile, userRef, tx) => {
    const nextProfile = recoverHearts(profile);
    const claimed = Math.max(0, nextProfile.hearts - profile.hearts);
    if (claimed > 0 || nextProfile.lastHeartAt !== profile.lastHeartAt) {
      tx.set(
        userRef,
        { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    return {
      claimed,
      nextHeartAt: getNextHeartAt(nextProfile),
      profile: publicProfile(nextProfile),
    };
  });
});

export const refundHeart = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  return runUserTransaction(uid, (profile, userRef, tx) => {
    const hearts = Math.min(MAX_HEARTS, profile.hearts + 1);
    const nextProfile = {
      ...profile,
      hearts,
      lastHeartAt: hearts >= MAX_HEARTS ? Date.now() : profile.lastHeartAt,
    };
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { profile: publicProfile(nextProfile) };
  });
});

export const recordRunProgress = onCall(async (request) => {
  const uid = assertAuthed(request.auth?.uid);
  const data = request.data as { run?: Partial<RunProgressPatch> };
  const run = {
    matchId: typeof data.run?.matchId === "string" ? data.run.matchId : undefined,
    score: clampInt(data.run?.score, 0, 0, 9999999),
    matchedCells: clampInt(data.run?.matchedCells, 0, 0, 99999),
    maxCombo: clampInt(data.run?.maxCombo, 0, 0, 999),
    specialTriggers: clampInt(data.run?.specialTriggers, 0, 0, 99999),
    feverCount: clampInt(data.run?.feverCount, 0, 0, 999),
  };
  if (run.score <= 0) throw new HttpsError("failed-precondition", "점수가 있는 기록만 저장돼요.");
  if (!run.matchId) throw new HttpsError("invalid-argument", "matchId가 필요해요.");

  return runUserTransaction(uid, async (profile, userRef, tx) => {
    const matchRef = db.doc(`matches/${run.matchId}`);
    const matchSnapshot = await tx.get(matchRef);
    if (!matchSnapshot.exists) throw new HttpsError("not-found", "매치 세션을 찾을 수 없어요.");
    const match = matchSnapshot.data() || {};
    if (match.userId !== uid) throw new HttpsError("permission-denied", "다른 계정의 매치예요.");
    if (match.status !== "finished" || match.accepted !== true) {
      throw new HttpsError("failed-precondition", "검증된 매치만 보상을 받을 수 있어요.");
    }
    if (match.rewardsClaimed === true) {
      throw new HttpsError("already-exists", "이미 보상이 지급된 매치예요.");
    }
    if (
      clampInt(match.score, 0, 0, 9999999) !== run.score ||
      clampInt(match.maxCombo, 0, 0, 999) !== run.maxCombo ||
      clampInt(match.matchedCells, 0, 0, 99999) !== run.matchedCells ||
      clampInt(match.specialTriggers, 0, 0, 99999) !== run.specialTriggers ||
      clampInt(match.feverCount, 0, 0, 999) !== run.feverCount
    ) {
      throw new HttpsError("permission-denied", "매치 결과가 세션 기록과 일치하지 않아요.");
    }

    const today = dayKey();
    const currentWeek = weekKey();
    const mission = pickDailyMission(today);
    const missionRef = db.doc(`dailyMissions/${uid}`);
    const weeklyMissionRef = db.doc(`weeklyMissions/${uid}`);
    const [missionSnapshot, weeklyMissionSnapshot] = await Promise.all([
      tx.get(missionRef),
      tx.get(weeklyMissionRef),
    ]);
    const missionState = normalizeDailyMissionState(missionSnapshot.data(), mission, today);
    const weeklyMissionState = normalizeWeeklyMissionState(
      weeklyMissionSnapshot.data(),
      currentWeek,
    );
    const alreadyCompletedToday = profile.completedDailyKeys.includes(today);
    const missionProgress = Math.max(missionState.progress, dailyMissionValue(mission, run));
    const missionClaimed =
      !missionState.claimed && !alreadyCompletedToday && missionProgress >= mission.goal;
    const nextMissionState = {
      ...missionState,
      progress: missionProgress,
      claimed: missionState.claimed || alreadyCompletedToday || missionClaimed,
    };
    const nextWeeklyMissionState = applyWeeklyMissionProgress(weeklyMissionState, run);
    const progress = normalizeProgressPatch(profile, run, missionClaimed, mission.rewardStars);
    const mainCharacter = profile.mainCharacter;
    const characterPlays = {
      ...profile.characterPlays,
      [mainCharacter]: (profile.characterPlays[mainCharacter] || 0) + 1,
    };
    const characterAffinity = {
      ...profile.characterAffinity,
      [mainCharacter]:
        (profile.characterAffinity[mainCharacter] || 0) + Math.max(1, Math.floor(run.score / 5000)),
    };
    const nextProfile = {
      ...profile,
      level: progress.level,
      xp: progress.xp,
      stars: progress.stars,
      streak: progress.streak,
      lastDailyKey: progress.lastDailyKey,
      completedDailyKeys: progress.completedDailyKeys,
      bestScore: Math.max(profile.bestScore, run.score),
      totalScore: profile.totalScore + run.score,
      totalPlays: profile.totalPlays + 1,
      totalMatches: profile.totalMatches + run.matchedCells,
      maxCombo: Math.max(profile.maxCombo, run.maxCombo),
      totalSpecials: profile.totalSpecials + run.specialTriggers,
      characterAffinity,
      characterPlays,
    };
    const guildContribution = await applyGuildContribution(tx, uid, nextProfile, run.score);
    tx.set(
      userRef,
      { ...profileDoc(nextProfile), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      matchRef,
      {
        rewardsClaimed: true,
        guildClaimed: guildContribution ? true : FieldValue.delete(),
        guildDamage: guildContribution?.damage ?? FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    const missionDoc: Record<string, unknown> = {
      ...nextMissionState,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (missionClaimed) missionDoc.claimedAt = FieldValue.serverTimestamp();
    else if (!missionState.claimed) missionDoc.claimedAt = null;
    tx.set(missionRef, missionDoc, { merge: true });
    tx.set(weeklyMissionRef, weeklyMissionDoc(nextWeeklyMissionState), { merge: true });
    return {
      profile: publicProfile(nextProfile),
      rewards: {
        ...progress.rewards,
        missionStars: missionClaimed ? mission.rewardStars : 0,
      },
      mission: buildDailyMissionStatus(nextMissionState, mission),
      weeklyMissions: buildWeeklyMissionStatus(nextWeeklyMissionState),
      guildContribution,
    };
  });
});
