import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import puppyImg from "@/assets/puppy.webp";
import catImg from "@/assets/cat.webp";
import rabbitImg from "@/assets/rabbit.webp";
import bearImg from "@/assets/bear.webp";
import pandaImg from "@/assets/panda.webp";
import chickImg from "@/assets/chick.webp";
import partyImg from "@/assets/party.webp";
import { claimAdReward } from "@/lib/adRewards";
import { isFirebaseConfigured } from "@/lib/firebaseConfig";
import {
  createGuild,
  getGuild,
  joinGuild,
  kickGuildMember,
  leaveGuild,
  recordGuildContribution,
  type GuildState,
} from "@/lib/guild";
import {
  fetchLeaderboard,
  sanitizeNickname,
  saveScore,
  type LeaderboardAudience,
  type LeaderboardEntry,
  type LeaderboardScope,
} from "@/lib/leaderboard";
import {
  claimDailyCheckin,
  claimWeeklyMission,
  claimSeasonPassReward,
  clearStage,
  getCharacterDex,
  getDailyCheckinStatus,
  getDailyMissionStatus,
  getSeasonCurrent,
  getSeasonPassStatus,
  getShopItems,
  getStageProgress,
  getWeeklyMissionStatus,
  levelUpCharacter,
  purchaseShopItem,
  setMainCharacter as saveMainCharacter,
  type CharacterDexEntry,
  type DailyCheckinStatus,
  type DailyMissionStatus,
  type SeasonCurrent,
  type SeasonPassStatus,
  type SeasonPassTrack,
  type ShopItem,
  type StageProgress,
  type WeeklyMissionStatus,
} from "@/lib/liveOps";
import {
  createSeededRandom,
  finishMatch,
  startMatch,
  type MatchMode,
  type MatchStartResult,
  type ReplayMove,
} from "@/lib/matchSession";
import {
  blockUser,
  getFriendCode,
  getFriends,
  inviteFriend,
  removeFriend,
  reportPlayer,
  type FriendEntry,
} from "@/lib/social";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
  type NotificationTopic,
} from "@/lib/notifications";
import {
  finishVersus,
  queueVersus,
  type VersusFinishResult,
  type VersusQueueResult,
} from "@/lib/versus";
import { logTelemetryEvent } from "@/lib/telemetry";
import {
  buildPlayerStats,
  claimHeartTimer,
  createRestoreCode,
  deletePlayerAccount,
  exportPlayerData,
  getNextHeartAt,
  ensurePlayer,
  getPlayerStats,
  linkPlayerAccount,
  MAX_HEARTS,
  recordRunProgress,
  recoverHearts,
  refundHeart,
  restorePlayerProfile,
  savePlayerNickname,
  spendHeart,
  type AccountProviderKey,
  type AuthProviderId,
  type CharacterId,
  type PlayerProfile,
  type PlayerStats,
} from "@/lib/player";
import {
  ANIMALS,
  COLS,
  ROWS,
  type Animal,
  type Cell,
  type Special,
  adjacent,
  collapseAndRefill,
  createBoard,
  expandSpecials,
  findHint,
  findMatches,
  hasAnyMatch,
  makeCell,
  matchGroups,
  specialFromMatch,
  swap,
} from "./engine";

const animalImg: Record<Animal, string> = {
  puppy: puppyImg,
  cat: catImg,
  rabbit: rabbitImg,
  bear: bearImg,
  panda: pandaImg,
  chick: chickImg,
};

const accountProviderLabels: Record<AuthProviderId, string> = {
  anonymous: "게스트",
  "google.com": "Google",
  "apple.com": "Apple",
  "oidc.kakao": "Kakao",
};

const accountLinkOptions: { key: AccountProviderKey; providerId: AuthProviderId; label: string }[] =
  [
    { key: "google", providerId: "google.com", label: "Google" },
    { key: "apple", providerId: "apple.com", label: "Apple" },
    { key: "kakao", providerId: "oidc.kakao", label: "Kakao" },
  ];

const GAME_SECONDS = 60;
const COMBO_TIMEOUT_MS = 2200;
const HINT_DELAY_MS = 3000;
const COMBO_HINT_DELAY_MS = 520;
const FEVER_DURATION_MS = 5000;
const FEVER_TRIGGER_COMBO = 4;
const FIRST_COMBO_TIMEOUT_MS = 2800;
const PRE_FEVER_COMBO_TIMEOUT_MS = 2500;
const PANG_GAUGE_PER_MATCH_CELL = 5;
const PANG_GAUGE_SPECIAL_BONUS = 10;
const MAX_ACTIVE_PANG_BOMBS = 3;
const TAP_SPECIALS = new Set<Special>(["bomb", "rainbow"]);
const NICKNAME_KEY = "anipang-player-name";
const ONBOARDING_KEY = "anipang-onboarding-seen";
const PROGRESS_KEY = "anipang-progress-v1";
const XP_PER_LEVEL = 1200;
const numberFormatter = new Intl.NumberFormat("en-US");

function formatNumber(value: number) {
  return numberFormatter.format(Math.round(value));
}

type HintMove = { from: [number, number]; to: [number, number]; label: string };

function comboWindowMs(comboValue: number) {
  if (comboValue <= 1) return FIRST_COMBO_TIMEOUT_MS;
  if (comboValue < FEVER_TRIGGER_COMBO) return PRE_FEVER_COMBO_TIMEOUT_MS;
  return COMBO_TIMEOUT_MS;
}

function vibrate(pattern: number | number[]) {
  if (typeof navigator === "undefined") return;
  const nav = navigator as Navigator & { vibrate?: (pattern: number | number[]) => boolean };
  nav.vibrate?.(pattern);
}

function hintLabel(from: [number, number], to: [number, number]) {
  if (to[0] < from[0]) return "^";
  if (to[0] > from[0]) return "v";
  if (to[1] < from[1]) return "<";
  return ">";
}

function findHintMove(board: Cell[][]): HintMove | null {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
      ]) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= ROWS || nc >= COLS) continue;
        const from: [number, number] = [r, c];
        const to: [number, number] = [nr, nc];
        const next = board.map((row) => row.slice());
        swap(next, from, to);
        if (hasAnyMatch(next)) return { from, to, label: hintLabel(from, to) };
      }
    }
  }
  return null;
}

function vipStatusLabel(vipUntil = 0) {
  const daysLeft = Math.ceil((vipUntil - Date.now()) / 86400000);
  return daysLeft > 0 ? `VIP D-${daysLeft}` : "VIP 미가입";
}

function comboMilestone(comboValue: number) {
  if (comboValue === 3) return { label: "GOOD COMBO", bonus: 700, color: "#ff7a3d" };
  if (comboValue === FEVER_TRIGGER_COMBO)
    return { label: "FEVER BONUS", bonus: 1400, color: "#f2c94c" };
  if (comboValue === 8) return { label: "MEGA COMBO", bonus: 2600, color: "#e64b8a" };
  if (comboValue > 8 && comboValue % 3 === 0)
    return { label: "COMBO BONUS", bonus: 1800, color: "#e64b8a" };
  return null;
}

type Phase = "start" | "playing" | "ended";

interface FloatText {
  id: number;
  x: number;
  y: number;
  text: string;
  color: string;
}
interface Particle {
  id: number;
  x: number;
  y: number;
  emoji: string;
  dx: number;
  dy: number;
  rotate: number;
  delay: number;
  scale: number;
}
interface DragState {
  from: [number, number];
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  pointerId: number;
  triggered: boolean;
}
interface Callout {
  id: number;
  title: string;
  detail: string;
  tone: "combo" | "fever" | "special" | "miss";
}
interface RunStats {
  matchedCells: number;
  specialTriggers: number;
  specialCreates: number;
  smileCreates: number;
  rainbowCreates: number;
  pangCreates: number;
  feverClears: number;
  missionBonus: number;
  lastPangBonus: number;
  missCount: number;
}
type MissionMetric =
  | "matchedCells"
  | "smileCreates"
  | "rainbowCreates"
  | "feverCount"
  | "maxCombo"
  | "specialTriggers";
interface Mission {
  id: string;
  label: string;
  title: string;
  detail: string;
  metric: MissionMetric;
  goal: number;
  bonus: number;
}
type DailyQuestMetric = "score" | "maxCombo" | "specialTriggers" | "feverCount";
interface DailyQuest {
  id: string;
  label: string;
  title: string;
  metric: DailyQuestMetric;
  goal: number;
  rewardStars: number;
}
interface ProgressProfile {
  level: number;
  xp: number;
  stars: number;
  streak: number;
  lastDailyKey: string;
  completedDailyKeys: string[];
}
interface RewardSummary {
  xp: number;
  stars: number;
  dailyCompleted: boolean;
  streak: number;
  leveledUp: boolean;
  unlockedPang: boolean;
}
type RankingStatus = "idle" | "saving" | "online" | "local" | "error";
type BoosterKey = "hint" | "shuffle" | "timePlus";
type RunBoosters = Record<BoosterKey, number>;
type LobbyRoute =
  | "home"
  | "profile"
  | "world"
  | "daily"
  | "pass"
  | "shop"
  | "collection"
  | "social";
interface OnboardingStep {
  label: string;
  title: string;
  detail: string;
  tips: string[];
}

const beginnerMissionPool: Mission[] = [
  {
    id: "clear-20",
    label: "START",
    title: "동물 20마리 터뜨리기",
    detail: "아무 3매치나 이어서 첫 흐름을 만들어보세요.",
    metric: "matchedCells",
    goal: 20,
    bonus: 1800,
  },
  {
    id: "combo-3",
    label: "COMBO",
    title: "3콤보 달성",
    detail: "게이지가 사라지기 전에 다음 매치를 이어보세요.",
    metric: "maxCombo",
    goal: 3,
    bonus: 2200,
  },
  {
    id: "smile-1",
    label: "4 MATCH",
    title: "웃는 블록 1개 만들기",
    detail: "같은 동물 4마리를 이어 특수 블록을 만들어보세요.",
    metric: "smileCreates",
    goal: 1,
    bonus: 2500,
  },
];

const missionPool: Mission[] = [
  {
    id: "smile-2",
    label: "4 MATCH",
    title: "웃는 블록 2개 만들기",
    detail: "4마리 매치를 노려 주변 8칸 폭발을 준비하세요.",
    metric: "smileCreates",
    goal: 2,
    bonus: 3500,
  },
  {
    id: "rainbow-1",
    label: "5 MATCH",
    title: "랜덤팡 1개 만들기",
    detail: "5마리 한 줄을 만들어 판 전체를 열어보세요.",
    metric: "rainbowCreates",
    goal: 1,
    bonus: 4500,
  },
  {
    id: "fever-2",
    label: "FEVER",
    title: "피버 2회 발동",
    detail: "콤보를 끊기지 않게 이어 5콤보를 두 번 넘겨보세요.",
    metric: "feverCount",
    goal: 2,
    bonus: 4000,
  },
  {
    id: "combo-8",
    label: "COMBO",
    title: "8콤보 달성",
    detail: "빠르게 이어 맞춰 한 번의 흐름을 길게 가져가세요.",
    metric: "maxCombo",
    goal: 8,
    bonus: 4000,
  },
  {
    id: "special-3",
    label: "CHAIN",
    title: "특수 효과 3회 발동",
    detail: "웃는 블록, 랜덤팡, 팡이를 연쇄로 터뜨려보세요.",
    metric: "specialTriggers",
    goal: 3,
    bonus: 3500,
  },
];

const dailyQuestPool: DailyQuest[] = [
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

const onboardingSteps: OnboardingStep[] = [
  {
    label: "STEP 1",
    title: "드래그로 동물을 바꿔요",
    detail: "옆 칸으로 밀어서 같은 동물 3개 이상을 이어주면 팡팡 터집니다.",
    tips: ["클릭 두 번이 아니라 밀어서 이동", "가로 또는 세로 3개부터 매치"],
  },
  {
    label: "STEP 2",
    title: "콤보를 끊기지 않게",
    detail: "연속으로 맞추면 점수가 크게 오르고, 5콤보마다 피버가 켜집니다.",
    tips: ["콤보 게이지가 사라지기 전 다음 매치", "피버 중에는 주변 블록도 함께 제거"],
  },
  {
    label: "STEP 3",
    title: "4매치와 5매치를 노려요",
    detail: "라운드 미션을 보면서 웃는 블록과 랜덤팡을 만들면 보너스 점수를 얻습니다.",
    tips: [
      "4매치는 주변 8칸 제거",
      "5매치는 같은 동물 한 종류 제거",
      "팡이와 보너스 블록은 LV3부터 등장",
    ],
  },
];

const emptyRunStats = (): RunStats => ({
  matchedCells: 0,
  specialTriggers: 0,
  specialCreates: 0,
  smileCreates: 0,
  rainbowCreates: 0,
  pangCreates: 0,
  feverClears: 0,
  missionBonus: 0,
  lastPangBonus: 0,
  missCount: 0,
});

const initialRunBoosters = (): RunBoosters => ({
  hint: 2,
  shuffle: 1,
  timePlus: 1,
});

function dayKeyFromDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayKey(now = Date.now()) {
  return dayKeyFromDate(new Date(now));
}

function previousDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return todayKey(Date.now() - 24 * 60 * 60 * 1000);
  date.setDate(date.getDate() - 1);
  return dayKeyFromDate(date);
}

function progressLevelFromXp(xp: number) {
  return Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1;
}

function emptyProgress(): ProgressProfile {
  return {
    level: 1,
    xp: 0,
    stars: 0,
    streak: 0,
    lastDailyKey: "",
    completedDailyKeys: [],
  };
}

function normalizeProgress(raw: Partial<ProgressProfile> | null): ProgressProfile {
  if (!raw) return emptyProgress();
  const xp = Math.max(0, Math.floor(Number(raw.xp) || 0));
  const stars = Math.max(0, Math.floor(Number(raw.stars) || 0));
  const streak = Math.max(0, Math.floor(Number(raw.streak) || 0));
  const completedDailyKeys = Array.isArray(raw.completedDailyKeys)
    ? raw.completedDailyKeys.filter((key): key is string => typeof key === "string").slice(-21)
    : [];

  return {
    level: progressLevelFromXp(xp),
    xp,
    stars,
    streak,
    lastDailyKey: typeof raw.lastDailyKey === "string" ? raw.lastDailyKey : "",
    completedDailyKeys,
  };
}

function loadProgress() {
  try {
    return normalizeProgress(JSON.parse(localStorage.getItem(PROGRESS_KEY) || "null"));
  } catch {
    return emptyProgress();
  }
}

function saveProgress(progress: ProgressProfile) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

function hasProfileProgress(profile: PlayerProfile) {
  return (
    profile.xp > 0 ||
    profile.stars > 0 ||
    profile.streak > 0 ||
    profile.completedDailyKeys.length > 0 ||
    profile.totalPlays > 0
  );
}

function progressFromPlayer(profile: PlayerProfile) {
  return normalizeProgress({
    level: profile.level,
    xp: profile.xp,
    stars: profile.stars,
    streak: profile.streak,
    lastDailyKey: profile.lastDailyKey,
    completedDailyKeys: profile.completedDailyKeys,
  });
}

function levelProgressPercent(progress: ProgressProfile) {
  return Math.min(100, Math.round(((progress.xp % XP_PER_LEVEL) / XP_PER_LEVEL) * 100));
}

function pickDailyQuest(dayKey: string) {
  const seed = [...dayKey].reduce(
    (total, char, index) => total + char.charCodeAt(0) * (index + 3),
    0,
  );
  return dailyQuestPool[seed % dailyQuestPool.length];
}

function dailyQuestValue(
  quest: DailyQuest,
  finalScore: number,
  finalMaxCombo: number,
  finalFeverCount: number,
  stats: RunStats,
) {
  if (quest.metric === "score") return finalScore;
  if (quest.metric === "maxCombo") return finalMaxCombo;
  if (quest.metric === "feverCount") return finalFeverCount;
  return stats.specialTriggers;
}

function resolveRunReward(
  finalScore: number,
  finalMaxCombo: number,
  finalFeverCount: number,
  stats: RunStats,
  completedMission: boolean,
  quest: DailyQuest,
  progress: ProgressProfile,
  dayKey: string,
): { profile: ProgressProfile; summary: RewardSummary } {
  if (finalScore <= 0) {
    return {
      profile: progress,
      summary: {
        xp: 0,
        stars: 0,
        dailyCompleted: false,
        streak: progress.streak,
        leveledUp: false,
        unlockedPang: false,
      },
    };
  }

  const baseXp = Math.max(
    20,
    Math.floor(finalScore / 500) +
      finalMaxCombo * 8 +
      stats.specialTriggers * 12 +
      finalFeverCount * 20 +
      (completedMission ? 40 : 0),
  );
  let stars = Math.max(5, Math.floor(finalScore / 2500) + stats.specialCreates * 2);
  const completedKeys = new Set(progress.completedDailyKeys);
  const dailyCompleted =
    !completedKeys.has(dayKey) &&
    dailyQuestValue(quest, finalScore, finalMaxCombo, finalFeverCount, stats) >= quest.goal;
  let streak = progress.streak;

  if (dailyCompleted) {
    streak = progress.lastDailyKey === previousDayKey(dayKey) ? progress.streak + 1 : 1;
    stars += quest.rewardStars;
    completedKeys.add(dayKey);
  }

  const nextXp = progress.xp + baseXp;
  const nextLevel = progressLevelFromXp(nextXp);
  const profile = normalizeProgress({
    ...progress,
    level: nextLevel,
    xp: nextXp,
    stars: progress.stars + stars,
    streak,
    lastDailyKey: dailyCompleted ? dayKey : progress.lastDailyKey,
    completedDailyKeys: [...completedKeys].sort().slice(-21),
  });

  return {
    profile,
    summary: {
      xp: baseXp,
      stars,
      dailyCompleted,
      streak: profile.streak,
      leveledUp: nextLevel > progress.level,
      unlockedPang: progress.level < 3 && nextLevel >= 3,
    },
  };
}

function createRunId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pickMission(progress?: ProgressProfile) {
  const pool = progress && progress.level <= 2 ? beginnerMissionPool : missionPool;
  return pool[Math.floor(Math.random() * pool.length)];
}

function missionProgress(mission: Mission, stats: RunStats, feverCount: number, maxCombo: number) {
  if (mission.metric === "matchedCells") return stats.matchedCells;
  if (mission.metric === "feverCount") return feverCount;
  if (mission.metric === "maxCombo") return maxCombo;
  return stats[mission.metric];
}

function countSpecial(board: Cell[][], special: Special) {
  return board.reduce(
    (total, row) => total + row.filter((cell) => cell.special === special).length,
    0,
  );
}

function specialName(special: Special) {
  if (special === "smile") return "웃는 블록";
  if (special === "rainbow") return "랜덤팡";
  if (special === "bomb") return "팡이";
  if (special === "coin") return "코인";
  if (special === "time") return "시간 보너스";
  return "특수 블록";
}

function specialDetail(special: Special) {
  if (special === "smile") return "매치하면 주변 8칸까지 터져요";
  if (special === "rainbow") return "누르면 같은 동물 한 종류가 사라져요";
  if (special === "bomb") return "누르면 세로줄과 맨 아랫줄이 터져요";
  return "연쇄 점수를 노려보세요";
}

function specialBadge(special: Special) {
  if (special === "smile") return <div className="special-badge special-smile">4</div>;
  if (special === "rainbow") return <div className="special-badge special-rainbow">5</div>;
  if (special === "bomb") return <div className="special-badge special-bomb">P</div>;
  if (special === "coin") return <div className="special-badge special-coin">+</div>;
  if (special === "time") return <div className="special-badge special-time">+3</div>;
  return null;
}

function formatHeartWait(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function stageStarsFromScore(value: number) {
  if (value >= 30000) return 3;
  if (value >= 15000) return 2;
  if (value > 0) return 1;
  return 0;
}

function characterLevelCost(character: CharacterDexEntry) {
  return Math.max(1, character.level || 1) * 80;
}

function shopCategoryLabel(category: ShopItem["category"]) {
  if (category === "hearts") return "HEART";
  if (category === "boosters") return "BOOST";
  if (category === "skins") return "SKIN";
  return "PACK";
}

function shopPriceLabel(item: ShopItem) {
  if (item.currency === "iap") return `₩${formatNumber(item.price)}`;
  return `${formatNumber(item.price)} ${item.currency === "stars" ? "별" : "코인"}`;
}

export default function Game() {
  const [phase, setPhase] = useState<Phase>("start");
  const [board, setBoard] = useState<Cell[][]>([]);
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [time, setTime] = useState(GAME_SECONDS);
  const [feverActive, setFeverActive] = useState(false);
  const [feverCount, setFeverCount] = useState(0);
  const [pangGauge, setPangGauge] = useState(0); // 0..100 -> next special drop
  const [feverGauge, setFeverGauge] = useState(0); // combo progress to next fever
  const [hint, setHint] = useState<HintMove | null>(null);
  const [floats, setFloats] = useState<FloatText[]>([]);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [newRecord, setNewRecord] = useState(false);
  const [nickname, setNickname] = useState("");
  const [player, setPlayer] = useState<PlayerProfile | null>(null);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [heartMessage, setHeartMessage] = useState("");
  const [heartTick, setHeartTick] = useState(Date.now());
  const [leaderboards, setLeaderboards] = useState<Record<LeaderboardScope, LeaderboardEntry[]>>({
    today: [],
    weekly: [],
    all: [],
  });
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [scoreSaved, setScoreSaved] = useState(false);
  const [rankingMessage, setRankingMessage] = useState("");
  const [rankingStatus, setRankingStatus] = useState<RankingStatus>("idle");
  const [rankingOpen, setRankingOpen] = useState(false);
  const [rankingScope, setRankingScope] = useState<LeaderboardScope>("weekly");
  const [rankingAudience, setRankingAudience] = useState<LeaderboardAudience>("global");
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState<AccountProviderKey | null>(null);
  const [accountRestoreBusy, setAccountRestoreBusy] = useState(false);
  const [accountRestoreCode, setAccountRestoreCode] = useState("");
  const [accountRestoreInput, setAccountRestoreInput] = useState("");
  const [accountDeleteArmed, setAccountDeleteArmed] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPreferences | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [comboWindow, setComboWindow] = useState(0);
  const [feverNotice, setFeverNotice] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [boardShake, setBoardShake] = useState(false);
  const [feverLeft, setFeverLeft] = useState(0);
  const [callout, setCallout] = useState<Callout | null>(null);
  const [runStats, setRunStats] = useState<RunStats>(() => emptyRunStats());
  const [missionCompleted, setMissionCompleted] = useState(false);
  const [progress, setProgress] = useState<ProgressProfile>(() => loadProgress());
  const [mission, setMission] = useState<Mission>(() => pickMission(loadProgress()));
  const [lastReward, setLastReward] = useState<RewardSummary | null>(null);
  const [boosters, setBoosters] = useState<RunBoosters>(() => initialRunBoosters());
  const [season, setSeason] = useState<SeasonCurrent | null>(null);
  const [lobbyRoute, setLobbyRoute] = useState<LobbyRoute>("home");
  const [shopItems, setShopItems] = useState<ShopItem[]>([]);
  const [dailyStatus, setDailyStatus] = useState<DailyCheckinStatus | null>(null);
  const [dailyMissionStatus, setDailyMissionStatus] = useState<DailyMissionStatus | null>(null);
  const [weeklyMissionStatus, setWeeklyMissionStatus] = useState<WeeklyMissionStatus | null>(null);
  const [seasonPassStatus, setSeasonPassStatus] = useState<SeasonPassStatus | null>(null);
  const [stageProgress, setStageProgress] = useState<StageProgress | null>(null);
  const [profileStats, setProfileStats] = useState<PlayerStats | null>(null);
  const [profileStatsLoading, setProfileStatsLoading] = useState(false);
  const [friendCode, setFriendCode] = useState("");
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [friendInput, setFriendInput] = useState("");
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialMessage, setSocialMessage] = useState("");
  const [guildState, setGuildState] = useState<GuildState | null>(null);
  const [guildNameInput, setGuildNameInput] = useState("");
  const [guildJoinInput, setGuildJoinInput] = useState("");
  const [versusStarting, setVersusStarting] = useState(false);
  const [activeVersus, setActiveVersus] = useState<VersusQueueResult | null>(null);
  const [versusResult, setVersusResult] = useState<VersusFinishResult | null>(null);
  const [liveOpsMessage, setLiveOpsMessage] = useState("");
  const [characterDex, setCharacterDex] = useState<CharacterDexEntry[]>([]);

  const boardRef = useRef<HTMLDivElement>(null);
  const [tile, setTile] = useState(48);
  const comboTimerRef = useRef<number | null>(null);
  const hintTimerRef = useRef<number | null>(null);
  const feverEndRef = useRef<number | null>(null);
  const feverNoticeRef = useRef<number | null>(null);
  const feverDeadlineRef = useRef(0);
  const calloutTimerRef = useRef<number | null>(null);
  const boardShakeTimerRef = useRef<number | null>(null);
  const comboDeadlineRef = useRef(0);
  const lastMoveAt = useRef<number>(Date.now());
  const floatId = useRef(1);
  const dragRef = useRef<DragState | null>(null);
  const scoreRef = useRef(0);
  const feverActiveRef = useRef(false);
  const currentRunIdRef = useRef<string>(createRunId());
  const currentMatchRef = useRef<MatchStartResult | null>(null);
  const currentVersusRef = useRef<VersusQueueResult | null>(null);
  const rngRef = useRef<() => number>(Math.random);
  const replayMovesRef = useRef<ReplayMove[]>([]);
  const rushWarningRef = useRef<number | null>(null);
  const savedRunIdRef = useRef<string | null>(null);
  const savingScoreRef = useRef(false);
  const missionCompletedRef = useRef(false);
  const timeBonusDropsRef = useRef(0);
  const playerInitRef = useRef(false);
  const heartClaimingRef = useRef(false);
  const openingNudgeRef = useRef(false);

  const addScore = useCallback((points: number) => {
    const nextScore = scoreRef.current + points;
    scoreRef.current = nextScore;
    setScore(nextScore);
    return nextScore;
  }, []);
  const currentDayKey = useMemo(() => todayKey(heartTick), [heartTick]);
  const dailyQuest = useMemo(() => pickDailyQuest(currentDayKey), [currentDayKey]);
  const activeDailyQuest = dailyMissionStatus?.mission ?? dailyQuest;
  const dailyDone =
    dailyMissionStatus?.claimed ?? progress.completedDailyKeys.includes(currentDayKey);
  const currentLevelPercent = levelProgressPercent(progress);

  // Build the randomized board only after hydration so SSR and client markup stay identical.
  useEffect(() => {
    setBoard(createBoard());
  }, []);

  useEffect(() => {
    void logTelemetryEvent("session_start", { route: "lobby" });
    return () => {
      void logTelemetryEvent("session_end", { route: lobbyRoute });
    };
    // Session telemetry should capture mount/unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load best
  useEffect(() => {
    const b = Number(localStorage.getItem("anipang-best") || 0);
    setBest(b);
  }, []);

  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  useEffect(() => {
    feverActiveRef.current = feverActive;
  }, [feverActive]);

  const refreshLeaderboards = useCallback(async () => {
    setLeaderboardLoading(true);
    try {
      const [today, weekly, all] = await Promise.all([
        fetchLeaderboard("today", rankingAudience),
        fetchLeaderboard("weekly", rankingAudience),
        fetchLeaderboard("all", rankingAudience),
      ]);
      setLeaderboards({ today, weekly, all });
    } finally {
      setLeaderboardLoading(false);
    }
  }, [rankingAudience]);

  useEffect(() => {
    if (playerInitRef.current) return;
    playerInitRef.current = true;
    const savedName = localStorage.getItem(NICKNAME_KEY);
    const initialName = savedName ? sanitizeNickname(savedName) : "";
    if (initialName) setNickname(initialName);
    if (!localStorage.getItem(ONBOARDING_KEY)) setOnboardingOpen(true);
    setPlayerLoading(true);
    void ensurePlayer(initialName)
      .then((profile) => {
        setPlayer(profile);
        setNickname(profile.nickname);
        setBest((currentBest) => Math.max(currentBest, profile.bestScore));
        const legacyProgress = loadProgress();
        const nextProgress = hasProfileProgress(profile)
          ? progressFromPlayer(profile)
          : legacyProgress;
        setProgress(nextProgress);
        setMission(pickMission(nextProgress));
      })
      .finally(() => setPlayerLoading(false));
    void refreshLeaderboards();
  }, [refreshLeaderboards]);

  useEffect(() => {
    if (!rankingOpen) return;
    void refreshLeaderboards();
  }, [rankingOpen, rankingAudience, refreshLeaderboards]);

  useEffect(() => {
    void getSeasonCurrent().then(setSeason);
    void getShopItems().then(setShopItems);
  }, []);

  useEffect(() => {
    if (!player) {
      setDailyStatus(null);
      setDailyMissionStatus(null);
      setWeeklyMissionStatus(null);
      setSeasonPassStatus(null);
      setStageProgress(null);
      setProfileStats(null);
      setCharacterDex([]);
      setFriendCode("");
      setFriends([]);
      setGuildState(null);
      return;
    }

    let cancelled = false;
    void Promise.all([
      getDailyCheckinStatus(player),
      getDailyMissionStatus(player),
      getWeeklyMissionStatus(player),
      getSeasonPassStatus(player),
      getStageProgress(player),
      getCharacterDex(player),
    ]).then(
      ([
        nextDailyStatus,
        nextDailyMissionStatus,
        nextWeeklyMissionStatus,
        nextSeasonPassStatus,
        nextStageProgress,
        nextCharacterDex,
      ]) => {
        if (cancelled) return;
        setDailyStatus(nextDailyStatus);
        setDailyMissionStatus(nextDailyMissionStatus);
        setWeeklyMissionStatus(nextWeeklyMissionStatus);
        setSeasonPassStatus(nextSeasonPassStatus);
        setStageProgress(nextStageProgress);
        setCharacterDex(nextCharacterDex);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [player]);

  useEffect(() => {
    if (!player || lobbyRoute !== "profile") return;

    let cancelled = false;
    setProfileStatsLoading(true);
    void getPlayerStats(player)
      .then((result) => {
        if (cancelled) return;
        setProfileStats(result.stats);
      })
      .catch(() => {
        if (cancelled) return;
        setProfileStats(buildPlayerStats(player));
      })
      .finally(() => {
        if (!cancelled) setProfileStatsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lobbyRoute, player]);

  useEffect(() => {
    if (!player || !accountOpen) return;

    let cancelled = false;
    void getNotificationPreferences(player)
      .then((preferences) => {
        if (!cancelled) setNotificationPrefs(preferences);
      })
      .catch(() => {
        if (!cancelled) setNotificationPrefs({ pushEnabled: true, topics: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [accountOpen, player]);

  useEffect(() => {
    if (!player || lobbyRoute !== "social") return;

    let cancelled = false;
    setSocialLoading(true);
    setSocialMessage("");
    void Promise.all([getFriendCode(player), getFriends(player), getGuild(player)])
      .then(([nextCode, nextFriends, nextGuildState]) => {
        if (cancelled) return;
        setFriendCode(nextCode);
        setFriends(nextFriends);
        setGuildState(nextGuildState);
      })
      .catch(() => {
        if (!cancelled) setSocialMessage("친구 정보를 불러오지 못했어요.");
      })
      .finally(() => {
        if (!cancelled) setSocialLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lobbyRoute, player]);

  useEffect(() => {
    const tick = window.setInterval(() => setHeartTick(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!player || playerLoading || heartClaimingRef.current) return;
    const readyProfile = recoverHearts(player, heartTick);
    if (readyProfile.hearts <= player.hearts) return;

    heartClaimingRef.current = true;
    void claimHeartTimer(player)
      .then((result) => {
        setPlayer(result.profile);
        if (result.claimed > 0) {
          setHeartMessage(`하트 ${result.claimed}개 회복`);
        }
      })
      .catch(() => {
        setPlayer(readyProfile);
      })
      .finally(() => {
        heartClaimingRef.current = false;
      });
  }, [heartTick, player, playerLoading]);

  // responsive tile size
  useEffect(() => {
    const calc = () => {
      if (!boardRef.current) return;
      const w = boardRef.current.clientWidth;
      setTile(Math.floor(w / COLS));
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, [phase]);

  // timer
  useEffect(() => {
    if (phase !== "playing" || countdown !== null) return;
    const t = window.setInterval(() => {
      setTime((s) => {
        if (s <= 1) {
          window.clearInterval(t);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [phase, countdown]);

  useEffect(() => {
    if (phase !== "playing" || countdown === null) return;
    const t = window.setTimeout(() => {
      setCountdown((current) => {
        if (current === null) return null;
        return current <= 1 ? null : current - 1;
      });
    }, 720);
    return () => window.clearTimeout(t);
  }, [phase, countdown]);

  // end game
  useEffect(() => {
    if (phase === "playing" && time === 0) {
      void lastPang();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, phase]);

  // hint timer
  const armHint = useCallback((b: Cell[][], delay = HINT_DELAY_MS) => {
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => {
      const h = findHintMove(b);
      if (h) setHint(h);
    }, delay);
  }, []);

  useEffect(() => {
    if (phase !== "playing" || busy || countdown !== null) return;
    armHint(board, combo > 0 ? COMBO_HINT_DELAY_MS : HINT_DELAY_MS);
    return () => {
      if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    };
  }, [board, phase, busy, countdown, combo, armHint]);

  useEffect(() => {
    if (phase !== "playing") {
      setComboWindow(0);
      return;
    }

    const tick = window.setInterval(() => {
      if (!comboDeadlineRef.current || combo <= 0) {
        setComboWindow(0);
        return;
      }
      const left = Math.max(0, comboDeadlineRef.current - Date.now());
      setComboWindow(Math.round((left / comboWindowMs(combo)) * 100));
    }, 80);

    return () => window.clearInterval(tick);
  }, [combo, phase]);

  useEffect(() => {
    if (phase !== "playing" || !feverActive) {
      setFeverLeft(0);
      return;
    }

    const tick = window.setInterval(() => {
      const left = Math.max(0, feverDeadlineRef.current - Date.now());
      setFeverLeft(Math.ceil(left / 1000));
    }, 120);

    return () => window.clearInterval(tick);
  }, [feverActive, phase]);

  useEffect(() => {
    return () => {
      if (comboTimerRef.current) window.clearTimeout(comboTimerRef.current);
      if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
      if (feverEndRef.current) window.clearTimeout(feverEndRef.current);
      if (feverNoticeRef.current) window.clearTimeout(feverNoticeRef.current);
      if (calloutTimerRef.current) window.clearTimeout(calloutTimerRef.current);
      if (boardShakeTimerRef.current) window.clearTimeout(boardShakeTimerRef.current);
    };
  }, []);

  const showCallout = useCallback(
    (title: string, detail: string, tone: Callout["tone"] = "special") => {
      if (calloutTimerRef.current) window.clearTimeout(calloutTimerRef.current);
      const id = floatId.current++;
      setCallout({ id, title, detail, tone });
      calloutTimerRef.current = window.setTimeout(() => setCallout(null), 1600);
    },
    [],
  );

  const pulseBoard = useCallback((duration = 260) => {
    if (boardShakeTimerRef.current) window.clearTimeout(boardShakeTimerRef.current);
    setBoardShake(true);
    boardShakeTimerRef.current = window.setTimeout(() => {
      setBoardShake(false);
      boardShakeTimerRef.current = null;
    }, duration);
  }, []);

  useEffect(() => {
    if (phase !== "playing" || countdown !== null) return;
    const warning = time <= 5 ? 5 : time <= 10 ? 10 : null;
    if (!warning || rushWarningRef.current === warning) return;
    rushWarningRef.current = warning;
    pulseBoard(warning === 5 ? 520 : 360);
    vibrate(warning === 5 ? [22, 30, 48] : [16, 24]);
    showCallout(warning === 5 ? "LAST 5!" : "LAST 10!", "마지막 러시로 콤보를 이어가요", "fever");
  }, [countdown, phase, pulseBoard, showCallout, time]);

  const addFloat = useCallback(
    (r: number, c: number, text: string, color = "#ff7a3d") => {
      const id = floatId.current++;
      setFloats((f) => [...f, { id, x: c * tile + tile / 2, y: r * tile + tile / 2, text, color }]);
      window.setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 900);
    },
    [tile],
  );

  const addParticle = (r: number, c: number, emoji: string, burst = 1) => {
    const created = Array.from({ length: burst }, (_, index) => {
      const angle = Math.random() * Math.PI * 2;
      const distance = tile * (0.32 + Math.random() * 0.58);
      const id = floatId.current++;
      return {
        id,
        x: c * tile + tile / 2,
        y: r * tile + tile / 2,
        emoji,
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance - tile * (0.45 + Math.random() * 0.35),
        rotate: -160 + Math.random() * 320,
        delay: index * 28,
        scale: 0.82 + Math.random() * 0.36,
      };
    });
    const ids = new Set(created.map((particle) => particle.id));
    setParticles((p) => [...p, ...created]);
    window.setTimeout(() => setParticles((p) => p.filter((x) => !ids.has(x.id))), 860);
  };

  useEffect(() => {
    if (phase !== "playing" || busy || countdown !== null || openingNudgeRef.current) return;
    const firstMove = findHintMove(board);
    if (!firstMove) return;
    openingNudgeRef.current = true;
    setHint(firstMove);
    addFloat(firstMove.from[0], firstMove.from[1], "SWIPE", "#26a7d8");
    showCallout("첫 콤보!", "빛나는 두 블록을 밀어보세요", "combo");
  }, [addFloat, board, busy, countdown, phase, showCallout]);

  useEffect(() => {
    if (phase !== "playing" || missionCompletedRef.current) return;
    const progress = missionProgress(mission, runStats, feverCount, maxCombo);
    if (progress < mission.goal) return;

    missionCompletedRef.current = true;
    setMissionCompleted(true);
    addScore(mission.bonus);
    setRunStats((stats) => ({ ...stats, missionBonus: stats.missionBonus + mission.bonus }));
    showCallout("미션 완료!", `${mission.title} · +${formatNumber(mission.bonus)}`, "fever");
    addFloat(3, 3, `MISSION +${formatNumber(mission.bonus)}`, "#ff7a3d");
    // Mission effects intentionally observe gameplay counters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mission, runStats, feverCount, maxCombo, showCallout, addScore]);

  const savePlayerName = () => {
    const cleanName = sanitizeNickname(nickname);
    setNickname(cleanName);
    localStorage.setItem(NICKNAME_KEY, cleanName);
    if (player) {
      const optimisticPlayer = { ...player, nickname: cleanName };
      setPlayer(optimisticPlayer);
      void savePlayerNickname(optimisticPlayer, cleanName).then(setPlayer);
    }
    setRankingMessage(`${cleanName}님으로 등록됐어요.`);
    setRankingStatus("idle");
    return cleanName;
  };

  const handleLinkAccount = async (provider: AccountProviderKey) => {
    if (!player) {
      setAccountMessage("계정 정보를 준비 중이에요.");
      return;
    }

    setAccountBusy(provider);
    setAccountMessage("");
    try {
      const cleanName = savePlayerName();
      const linkedPlayer = await linkPlayerAccount({ ...player, nickname: cleanName }, provider);
      setPlayer(linkedPlayer);
      setNickname(linkedPlayer.nickname);
      setAccountMessage(`${accountProviderLabels[linkedPlayer.authProvider]} 계정으로 연결됐어요.`);
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "계정 연동에 실패했어요.");
    } finally {
      setAccountBusy(null);
    }
  };

  const copyPlayerId = async () => {
    if (!player) return;
    const id = player.uid;
    try {
      await navigator.clipboard.writeText(id);
      setAccountMessage("유저 ID를 복사했어요.");
    } catch {
      setAccountMessage(id);
    }
  };

  const handleNotificationToggle = async (topic?: NotificationTopic) => {
    if (!player) {
      setAccountMessage("계정 정보를 준비 중이에요.");
      return;
    }

    const current = notificationPrefs ?? { pushEnabled: true, topics: [] };
    const topics = new Set(current.topics);
    if (topic) {
      if (topics.has(topic)) topics.delete(topic);
      else topics.add(topic);
    }
    const nextPrefs = {
      pushEnabled: topic ? current.pushEnabled : !current.pushEnabled,
      topics: Array.from(topics),
    };
    setNotificationPrefs(nextPrefs);
    try {
      const saved = await updateNotificationPreferences(player, nextPrefs);
      setNotificationPrefs(saved);
      setAccountMessage("알림 설정을 저장했어요.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "알림 설정 저장에 실패했어요.");
    }
  };

  const handleCreateRestoreCode = async () => {
    if (!player) {
      setAccountMessage("계정 정보를 준비 중이에요.");
      return;
    }

    setAccountRestoreBusy(true);
    setAccountMessage("");
    try {
      const result = await createRestoreCode(player);
      setAccountRestoreCode(result.code);
      setAccountMessage("복원 코드는 10분 동안 사용할 수 있어요.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "복원 코드를 만들지 못했어요.");
    } finally {
      setAccountRestoreBusy(false);
    }
  };

  const handleRestoreProfile = async () => {
    if (!player) {
      setAccountMessage("계정 정보를 준비 중이에요.");
      return;
    }

    const code = accountRestoreInput.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (code.length !== 6) {
      setAccountMessage("6자리 복원 코드를 입력해주세요.");
      return;
    }

    setAccountRestoreBusy(true);
    setAccountMessage("");
    try {
      const restoredPlayer = await restorePlayerProfile(player, code);
      setPlayer(restoredPlayer);
      setNickname(restoredPlayer.nickname);
      setBest((currentBest) => Math.max(currentBest, restoredPlayer.bestScore));
      const nextProgress = progressFromPlayer(restoredPlayer);
      setProgress(nextProgress);
      saveProgress(nextProgress);
      setMission(pickMission(nextProgress));
      setAccountRestoreInput("");
      setAccountRestoreCode("");
      setAccountMessage("프로필을 이 기기에 복원했어요.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "프로필 복원에 실패했어요.");
    } finally {
      setAccountRestoreBusy(false);
    }
  };

  const handleInviteFriend = async () => {
    if (!player) {
      setSocialMessage("계정 정보를 준비 중이에요.");
      return;
    }

    const code = friendInput.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (code.length !== 6) {
      setSocialMessage("6자리 친구 코드를 입력해주세요.");
      return;
    }

    setSocialLoading(true);
    setSocialMessage("");
    try {
      const friend = await inviteFriend(player, code);
      const nextFriends = await getFriends(player).catch(() => [
        friend,
        ...friends.filter((item) => item.id !== friend.id),
      ]);
      setFriends(nextFriends);
      setFriendInput("");
      setSocialMessage(`${friend.nickname}님을 친구로 추가했어요.`);
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : "친구 추가에 실패했어요.");
    } finally {
      setSocialLoading(false);
    }
  };

  const handleRemoveFriend = async (friendId: string) => {
    if (!player) return;
    setSocialLoading(true);
    setSocialMessage("");
    try {
      await removeFriend(player, friendId);
      setFriends((items) => items.filter((item) => item.id !== friendId));
      setSocialMessage("친구를 삭제했어요.");
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : "친구 삭제에 실패했어요.");
    } finally {
      setSocialLoading(false);
    }
  };

  const handleBlockFriend = async (friendId: string) => {
    if (!player) return;
    setSocialLoading(true);
    setSocialMessage("");
    try {
      await blockUser(player, friendId);
      setFriends((items) => items.filter((item) => item.id !== friendId));
      setSocialMessage("친구를 차단했어요.");
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : "차단에 실패했어요.");
    } finally {
      setSocialLoading(false);
    }
  };

  const handleReportFriend = async (friendId: string) => {
    if (!player) return;
    setSocialLoading(true);
    setSocialMessage("");
    try {
      await reportPlayer(player, friendId, "cheat");
      setSocialMessage("신고를 접수했어요.");
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : "신고에 실패했어요.");
    } finally {
      setSocialLoading(false);
    }
  };

  const handleCreateGuild = async () => {
    if (!player) {
      setSocialMessage("계정 정보를 준비 중이에요.");
      return;
    }

    setSocialLoading(true);
    setSocialMessage("");
    try {
      const nextGuild = await createGuild(player, guildNameInput, "함께 보스를 공략해요.");
      setGuildState(nextGuild);
      setGuildNameInput("");
      setGuildJoinInput("");
      setSocialMessage(`${nextGuild.guild?.name ?? "길드"}가 만들어졌어요.`);
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : "길드를 만들지 못했어요.");
    } finally {
      setSocialLoading(false);
    }
  };

  const handleJoinGuild = async () => {
    if (!player) {
      setSocialMessage("계정 정보를 준비 중이에요.");
      return;
    }

    setSocialLoading(true);
    setSocialMessage("");
    try {
      const nextGuild = await joinGuild(player, guildJoinInput);
      setGuildState(nextGuild);
      setGuildJoinInput("");
      setSocialMessage(`${nextGuild.guild?.name ?? "길드"}에 가입했어요.`);
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : "길드 가입에 실패했어요.");
    } finally {
      setSocialLoading(false);
    }
  };

  const handleLeaveGuild = async () => {
    if (!player) return;
    setSocialLoading(true);
    setSocialMessage("");
    try {
      const nextGuild = await leaveGuild(player);
      setGuildState(nextGuild);
      setSocialMessage("길드에서 나왔어요.");
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : "길드에서 나가지 못했어요.");
    } finally {
      setSocialLoading(false);
    }
  };

  const handleKickGuildMember = async (memberId: string) => {
    if (!player) return;
    setSocialLoading(true);
    setSocialMessage("");
    try {
      const nextGuild = await kickGuildMember(player, memberId);
      setGuildState(nextGuild);
      setSocialMessage("길드 멤버를 내보냈어요.");
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : "멤버를 내보내지 못했어요.");
    } finally {
      setSocialLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!player) {
      setAccountMessage("계정 정보를 준비 중이에요.");
      return;
    }

    if (!accountDeleteArmed) {
      setAccountDeleteArmed(true);
      setAccountMessage("계정과 저장 데이터를 삭제하려면 한 번 더 눌러주세요.");
      return;
    }

    setAccountRestoreBusy(true);
    setAccountMessage("");
    try {
      await deletePlayerAccount(player);
      setAccountOpen(false);
      setAccountDeleteArmed(false);
      setAccountRestoreCode("");
      setAccountRestoreInput("");
      setPlayerLoading(true);
      const freshPlayer = await ensurePlayer(nickname);
      setPlayer(freshPlayer);
      setNickname(freshPlayer.nickname);
      setBest(freshPlayer.bestScore);
      const nextProgress = progressFromPlayer(freshPlayer);
      setProgress(nextProgress);
      saveProgress(nextProgress);
      setMission(pickMission(nextProgress));
      setRankingMessage("새 게스트 계정을 준비했어요.");
      setRankingStatus("idle");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "계정 삭제에 실패했어요.");
    } finally {
      setAccountRestoreBusy(false);
      setPlayerLoading(false);
    }
  };

  const handleExportAccountData = async () => {
    if (!player) {
      setAccountMessage("계정 정보를 준비 중이에요.");
      return;
    }

    setAccountRestoreBusy(true);
    setAccountMessage("");
    try {
      const data = await exportPlayerData(player);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pangpang-player-${player.uid.slice(-8)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setAccountMessage("계정 데이터 내보내기를 준비했어요.");
    } catch (error) {
      setAccountMessage(
        error instanceof Error ? error.message : "계정 데이터 내보내기에 실패했어요.",
      );
    } finally {
      setAccountRestoreBusy(false);
    }
  };

  const showOnboarding = () => {
    setOnboardingStep(0);
    setOnboardingOpen(true);
  };

  const closeOnboarding = () => {
    void logTelemetryEvent("tutorial_step", { step: onboardingStep, action: "close" });
    localStorage.setItem(ONBOARDING_KEY, "1");
    setOnboardingOpen(false);
    setOnboardingStep(0);
  };

  const handleOnboardingStepChange = (step: number) => {
    void logTelemetryEvent("tutorial_step", { step, action: "view" });
    setOnboardingStep(step);
  };

  const advanceOnboarding = () => {
    if (onboardingStep >= onboardingSteps.length - 1) {
      closeOnboarding();
      return;
    }
    setOnboardingStep((step) => {
      const nextStep = step + 1;
      void logTelemetryEvent("tutorial_step", { step: nextStep, action: "next" });
      return nextStep;
    });
  };

  const syncProgressStars = (profile: PlayerProfile) => {
    const nextProgress = normalizeProgress({ ...progress, stars: profile.stars });
    setProgress(nextProgress);
    saveProgress(nextProgress);
  };

  const handleClaimDaily = async () => {
    if (!player) {
      setLiveOpsMessage("계정 정보를 준비 중이에요.");
      return;
    }

    try {
      const result = await claimDailyCheckin(player);
      setPlayer(result.profile);
      setDailyStatus(result.status);
      syncProgressStars(result.profile);
      setLiveOpsMessage(
        result.rewards.stars > 0
          ? `출석 보상 +${result.rewards.stars}별`
          : "오늘 출석 보상은 이미 받았어요.",
      );
      void logTelemetryEvent("daily_claim", {
        granted: result.rewards.stars > 0,
        stars: result.rewards.stars,
      });
    } catch {
      setLiveOpsMessage("출석 저장에 실패했어요.");
    }
  };

  const handleClaimWeeklyMission = async (missionId: string) => {
    if (!player) {
      setLiveOpsMessage("계정 정보를 준비 중이에요.");
      return;
    }

    try {
      const result = await claimWeeklyMission(player, missionId);
      setPlayer(result.profile);
      setWeeklyMissionStatus(result.status);
      syncProgressStars(result.profile);
      setLiveOpsMessage(result.message);
      void logTelemetryEvent("mission_claim", {
        missionId,
        period: "weekly",
        granted: result.granted,
        stars: result.rewards.stars,
      });
    } catch {
      setLiveOpsMessage("주간 미션 저장에 실패했어요.");
    }
  };

  const handleClearStageReward = async () => {
    if (!player) {
      setLiveOpsMessage("계정 정보를 준비 중이에요.");
      return;
    }

    const earnedStars = stageStarsFromScore(best);
    if (earnedStars <= 0) {
      setLiveOpsMessage("기록을 남기면 월드 별 보상을 받을 수 있어요.");
      return;
    }

    try {
      const result = await clearStage(player, {
        stageId: stageProgress?.currentStage ?? 1,
        stars: earnedStars,
        score: best,
      });
      setPlayer(result.profile);
      setStageProgress(result.progress);
      syncProgressStars(result.profile);
      setLiveOpsMessage(
        result.rewards.stars > 0
          ? `월드 보상 +${result.rewards.stars}별`
          : "이미 최고 별 보상을 받았어요.",
      );
    } catch {
      setLiveOpsMessage("월드 보상 저장에 실패했어요.");
    }
  };

  const handlePurchaseItem = async (item: ShopItem) => {
    if (!player) {
      setLiveOpsMessage("계정 정보를 준비 중이에요.");
      return;
    }

    try {
      const result = await purchaseShopItem(player, item);
      setPlayer(result.profile);
      syncProgressStars(result.profile);
      setLiveOpsMessage(result.message);
      void logTelemetryEvent("purchase", {
        productId: item.productId ?? item.id,
        price: item.price,
        currency: item.currency,
        purchased: result.purchased,
      });
    } catch {
      setLiveOpsMessage("상점 저장에 실패했어요.");
    }
  };

  const handleClaimAdReward = async () => {
    if (!player) {
      setLiveOpsMessage("계정 정보를 준비 중이에요.");
      return;
    }

    void logTelemetryEvent("ad_request", { rewardType: "heart" });
    try {
      void logTelemetryEvent("ad_view", { rewardType: "heart", completed: true });
      const result = await claimAdReward(player, "heart");
      setPlayer(result.profile);
      syncProgressStars(result.profile);
      setLiveOpsMessage(
        result.rewards.hearts && result.rewards.hearts > 0
          ? "광고 보상 하트 +1"
          : "하트가 이미 가득 차 있어요.",
      );
      void logTelemetryEvent("ad_reward", {
        rewardType: "heart",
        granted: result.granted,
        alreadyGranted: result.alreadyGranted,
      });
    } catch {
      setLiveOpsMessage("광고 보상 지급에 실패했어요.");
    }
  };

  const handleClaimSeasonPassReward = async (level: number, track: SeasonPassTrack) => {
    if (!player) {
      setLiveOpsMessage("계정 정보를 준비 중이에요.");
      return;
    }

    try {
      const result = await claimSeasonPassReward(player, { level, track });
      setPlayer(result.profile);
      setSeasonPassStatus(result.status);
      syncProgressStars(result.profile);
      setLiveOpsMessage(result.message);
      void logTelemetryEvent("pass_claim", {
        level,
        track,
        granted: result.granted,
      });
    } catch {
      setLiveOpsMessage("패스 보상 저장에 실패했어요.");
    }
  };

  const handleSetMainCharacter = async (animal: CharacterId) => {
    if (!player) {
      setLiveOpsMessage("계정 정보를 준비 중이에요.");
      return;
    }

    try {
      const nextPlayer = await saveMainCharacter(player, animal);
      setPlayer(nextPlayer);
      setLiveOpsMessage("대표 캐릭터가 바뀌었어요.");
    } catch {
      setLiveOpsMessage("캐릭터 저장에 실패했어요.");
    }
  };

  const handleLevelUpCharacter = async (character: CharacterDexEntry) => {
    if (!player) {
      setLiveOpsMessage("계정 정보를 준비 중이에요.");
      return;
    }

    try {
      const result = await levelUpCharacter(player, character.animal);
      setPlayer(result.profile);
      syncProgressStars(result.profile);
      setLiveOpsMessage(
        result.leveled
          ? `${character.name} LV ${character.level + 1}`
          : `별 ${result.cost}개가 필요해요.`,
      );
    } catch {
      setLiveOpsMessage("캐릭터 강화에 실패했어요.");
    }
  };

  const startGame = async (mode: MatchMode = "rush") => {
    const isVersus = mode === "versus";
    if (playerLoading) {
      setHeartMessage("계정 정보를 준비 중이에요.");
      return;
    }

    const cleanName = savePlayerName();
    const readyPlayer = player ? recoverHearts({ ...player, nickname: cleanName }) : null;
    if (!readyPlayer) {
      setHeartMessage("계정 정보를 다시 불러오는 중이에요.");
      setPlayerLoading(true);
      const loadedPlayer = await ensurePlayer(cleanName);
      setPlayer(loadedPlayer);
      setPlayerLoading(false);
      return;
    }

    let heartResult: Awaited<ReturnType<typeof spendHeart>>;
    try {
      heartResult = await spendHeart(readyPlayer);
    } catch (error) {
      setHeartMessage(error instanceof Error ? error.message : "하트를 사용할 수 없어요.");
      return;
    }
    setPlayer(heartResult.profile);
    if (!heartResult.spent) {
      setHeartMessage("하트가 부족해요. 회복되면 다시 도전할 수 있어요.");
      return;
    }

    if (isVersus) setVersusStarting(true);
    let queuedVersus: VersusQueueResult | null = null;
    let matchSession: MatchStartResult;
    try {
      currentRunIdRef.current = createRunId();
      if (isVersus) {
        queuedVersus = await queueVersus(heartResult.profile);
        matchSession = queuedVersus.match;
      } else {
        matchSession = await startMatch({
          matchId: currentRunIdRef.current,
          playerUid: heartResult.profile.uid,
          mode,
        });
      }
    } catch (error) {
      const refundedPlayer = await refundHeart(heartResult.profile).catch(
        () => heartResult.profile,
      );
      setPlayer(refundedPlayer);
      setHeartMessage(error instanceof Error ? error.message : "매치를 시작하지 못했어요.");
      setVersusStarting(false);
      return;
    }

    currentRunIdRef.current = matchSession.matchId;
    currentMatchRef.current = matchSession;
    currentVersusRef.current = queuedVersus;
    setActiveVersus(queuedVersus);
    rngRef.current = createSeededRandom(matchSession.seed);
    void logTelemetryEvent("match_start", {
      mode: matchSession.mode,
      savedOnline: matchSession.savedOnline,
    });
    replayMovesRef.current = [];
    rushWarningRef.current = null;
    savedRunIdRef.current = null;
    savingScoreRef.current = false;
    missionCompletedRef.current = false;
    timeBonusDropsRef.current = 0;
    openingNudgeRef.current = false;
    setHeartMessage(
      queuedVersus ? `${queuedVersus.opponent.nickname}님과 대전 매칭!` : "하트 1개를 사용했어요.",
    );
    if (phase === "ended") setMission(pickMission(progress));
    if (feverEndRef.current) window.clearTimeout(feverEndRef.current);
    if (feverNoticeRef.current) window.clearTimeout(feverNoticeRef.current);
    feverEndRef.current = null;
    feverNoticeRef.current = null;
    scoreRef.current = 0;
    feverActiveRef.current = false;
    setMissionCompleted(false);
    setLastReward(null);
    setBoard(createBoard(rngRef.current));
    setScore(0);
    setCombo(0);
    setMaxCombo(0);
    setTime(GAME_SECONDS);
    setFeverActive(false);
    setFeverCount(0);
    setPangGauge(0);
    setFeverGauge(0);
    setNewRecord(false);
    setScoreSaved(false);
    setRankingMessage("");
    setRankingStatus("idle");
    setVersusResult(null);
    setComboWindow(0);
    setFeverNotice(false);
    setCountdown(3);
    setBoardShake(false);
    setFeverLeft(0);
    setCallout(null);
    setRunStats(emptyRunStats());
    setBoosters(initialRunBoosters());
    setSelected(null);
    setMatched(new Set());
    setHint(null);
    setFloats([]);
    setParticles([]);
    setBusy(false);
    setPhase("playing");
    if (isVersus) setVersusStarting(false);
  };

  const showStart = () => {
    setPhase("start");
    setLobbyRoute("home");
    setRankingMessage("");
    setRankingStatus("idle");
    currentVersusRef.current = null;
    setActiveVersus(null);
    setVersusResult(null);
    setCountdown(null);
    missionCompletedRef.current = false;
    setMissionCompleted(false);
    setMission(pickMission(progress));
    void refreshLeaderboards();
  };

  const handleBooster = (kind: BoosterKey) => {
    if (phase !== "playing" || busy || countdown !== null || boosters[kind] <= 0) return;

    let used = true;

    if (kind === "hint") {
      const nextHint = findHintMove(board);
      if (!nextHint) {
        used = false;
        showCallout("힌트 없음", "보드를 한 번 섞어보세요", "miss");
      } else {
        setHint(nextHint);
        addFloat(nextHint.from[0], nextHint.from[1], "HINT", "#26a7d8");
        showCallout("힌트 표시", "빛나는 두 블록을 밀어보세요", "combo");
      }
    }

    if (kind === "shuffle") {
      const nextBoard = createBoard(rngRef.current);
      if (comboTimerRef.current) window.clearTimeout(comboTimerRef.current);
      comboDeadlineRef.current = 0;
      setCombo(0);
      setFeverGauge(0);
      setComboWindow(0);
      setSelected(null);
      setHint(null);
      setBoard(nextBoard);
      pulseBoard(320);
      showCallout("MIX!", "보드가 새로 섞였어요", "special");
    }

    if (kind === "timePlus") {
      setTime((current) => Math.min(GAME_SECONDS + 10, current + 3));
      showCallout("+3초", "마지막 러시 시간을 벌었어요", "fever");
    }

    if (!used) return;
    setBoosters((current) => ({ ...current, [kind]: Math.max(0, current[kind] - 1) }));
  };

  const breakComboLater = useCallback((comboValue: number) => {
    if (comboTimerRef.current) window.clearTimeout(comboTimerRef.current);
    if (comboValue <= 0) {
      comboDeadlineRef.current = 0;
      setComboWindow(0);
      return;
    }

    const timeout = comboWindowMs(comboValue);
    comboDeadlineRef.current = Date.now() + timeout;
    setComboWindow(100);
    comboTimerRef.current = window.setTimeout(() => {
      setCombo(0);
      setFeverGauge(0);
      setComboWindow(0);
      comboDeadlineRef.current = 0;
    }, timeout);
  }, []);

  const triggerFever = useCallback(() => {
    vibrate([20, 35, 50]);
    feverActiveRef.current = true;
    setFeverActive(true);
    setFeverNotice(true);
    setFeverCount((f) => f + 1);
    setFeverGauge(100);
    setFeverLeft(Math.ceil(FEVER_DURATION_MS / 1000));
    feverDeadlineRef.current = Date.now() + FEVER_DURATION_MS;
    pulseBoard(420);
    showCallout("FEVER TIME!", "상하좌우 블록까지 함께 터져요", "fever");
    if (feverEndRef.current) window.clearTimeout(feverEndRef.current);
    if (feverNoticeRef.current) window.clearTimeout(feverNoticeRef.current);
    feverNoticeRef.current = window.setTimeout(() => setFeverNotice(false), 1500);
    feverEndRef.current = window.setTimeout(() => {
      feverActiveRef.current = false;
      setFeverActive(false);
      setFeverLeft(0);
    }, FEVER_DURATION_MS);
  }, [pulseBoard, showCallout]);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const addPangBomb = (b: Cell[][]) => {
    if (countSpecial(b, "bomb") >= MAX_ACTIVE_PANG_BOMBS) return false;
    const picks: [number, number][] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (b[r][c].special === "none") picks.push([r, c]);
      }
    }
    if (!picks.length) return false;
    const [pr, pc] = picks[Math.floor(rngRef.current() * picks.length)];
    b[pr][pc] = { ...b[pr][pc], special: "bomb" };
    pulseBoard(240);
    addFloat(pr, pc, "PANG!", "#ff7a3d");
    addParticle(pr, pc, "💥");
    setRunStats((stats) => ({
      ...stats,
      specialCreates: stats.specialCreates + 1,
      pangCreates: stats.pangCreates + 1,
    }));
    showCallout("팡이 등장!", "누르면 세로줄과 맨 아랫줄이 터져요", "special");
    return true;
  };

  const addBonusSpecial = (b: Cell[][], special: Extract<Special, "coin" | "time">) => {
    const picks: [number, number][] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (b[r][c].special === "none") picks.push([r, c]);
      }
    }
    if (!picks.length) return false;
    const [pr, pc] = picks[Math.floor(rngRef.current() * picks.length)];
    b[pr][pc] = { ...b[pr][pc], special };
    addFloat(
      pr,
      pc,
      special === "time" ? "+TIME" : "BONUS",
      special === "time" ? "#26a7d8" : "#f7b500",
    );
    addParticle(pr, pc, special === "time" ? "⏱" : "✨");
    if (special === "time") timeBonusDropsRef.current += 1;
    return true;
  };

  const maybeDropBonusSpecial = (b: Cell[][], chainCombo: number, createdSpecials: number) => {
    if (
      timeBonusDropsRef.current < 2 &&
      countSpecial(b, "time") === 0 &&
      chainCombo >= 4 &&
      rngRef.current() < 0.22
    ) {
      addBonusSpecial(b, "time");
      return;
    }

    if (
      countSpecial(b, "coin") < 3 &&
      ((createdSpecials > 0 && rngRef.current() < 0.34) ||
        (chainCombo >= 3 && rngRef.current() < 0.16))
    ) {
      addBonusSpecial(b, "coin");
    }
  };

  const chargePangGauge = (b: Cell[][], cells: number) => {
    if (cells <= 0) return;
    setPangGauge((g) => {
      if (countSpecial(b, "bomb") >= MAX_ACTIVE_PANG_BOMBS) return Math.min(g, 86);
      const next = g + cells * PANG_GAUGE_PER_MATCH_CELL;
      if (next >= 100) {
        return addPangBomb(b) ? Math.min(35, next - 100) : Math.min(86, next);
      }
      return next;
    });
  };

  const chargePangGaugeFromMove = (b: Cell[][], cells: number, createdSpecials: number) => {
    const bonus = createdSpecials > 0 ? PANG_GAUGE_SPECIAL_BONUS : 0;
    chargePangGauge(b, cells + Math.ceil(bonus / PANG_GAUGE_PER_MATCH_CELL));
  };

  const celebrateClear = (
    origin: [number, number],
    cells: number,
    comboValue: number,
    specialImpact: number,
    feverOn: boolean,
  ) => {
    const [r, c] = origin;
    if (feverOn || cells >= 10 || specialImpact >= 2) {
      addFloat(Math.max(0, r - 3), c, feverOn ? "FEVER PANG!" : "SUPER PANG!", "#f2c94c");
      addParticle(r, c, "★", 8);
      addParticle(Math.min(ROWS - 1, r + 1), Math.min(COLS - 1, c + 1), "✦", 5);
      return;
    }

    if (cells >= 6 || specialImpact > 0) {
      addFloat(Math.max(0, r - 3), c, specialImpact > 0 ? "POWER PANG!" : "BIG PANG!", "#ff7a3d");
      addParticle(r, c, "✦", 5);
      return;
    }

    if (comboValue >= FEVER_TRIGGER_COMBO - 1) {
      addParticle(r, c, "★", 3);
    }
  };

  const applyClear = async (
    startBoard: Cell[][],
    seedCleared: boolean[][],
    comboStart: number,
    label?: string,
  ) => {
    let b = startBoard.map((row) => row.slice());
    const nextCombo = comboStart + 1;
    const feverOn = feverActiveRef.current;
    const exp = expandSpecials(b, seedCleared, feverOn, rngRef.current);
    const cleared = exp.cleared;
    let cells = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (cleared[r][c]) cells++;
    if (cells === 0) return b;

    setCombo(nextCombo);
    setMaxCombo((m) => Math.max(m, nextCombo));
    setFeverGauge(((nextCombo % FEVER_TRIGGER_COMBO) / FEVER_TRIGGER_COMBO) * 100);
    if (nextCombo % FEVER_TRIGGER_COMBO === 0) triggerFever();

    const baseScore = cells * 35;
    const comboBonus = Math.floor(baseScore * Math.max(0, nextCombo - 1) * 0.55);
    const milestone = comboMilestone(nextCombo);
    const milestoneBonus = milestone?.bonus ?? 0;
    const feverMult = feverOn ? 2 : 1;
    const gained = (baseScore + comboBonus + exp.coinHits * 200 + milestoneBonus) * feverMult;
    addScore(gained);
    setRunStats((stats) => ({
      ...stats,
      matchedCells: stats.matchedCells + cells,
      specialTriggers: stats.specialTriggers + exp.specialsTriggered,
      feverClears: stats.feverClears + (feverOn ? cells : 0),
    }));
    if (exp.timeHits > 0) setTime((t) => Math.min(GAME_SECONDS + 10, t + 3 * exp.timeHits));
    pulseBoard(feverOn || exp.specialsTriggered > 0 || cells >= 6 ? 300 : 160);
    vibrate(feverOn || exp.specialsTriggered > 0 ? [14, 24, 36] : cells >= 6 ? [12, 22] : 12);

    const matchedSet = new Set<number>();
    let firstCleared: [number, number] | null = null;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!cleared[r][c]) continue;
        matchedSet.add(b[r][c].id);
        firstCleared ??= [r, c];
        const sp = b[r][c].special;
        if (sp === "coin") addParticle(r, c, "✨", 3);
        else if (sp === "time") addParticle(r, c, "⏱", 3);
        else if (sp !== "none") addParticle(r, c, "💥", 4);
        else if (Math.random() < 0.45) addParticle(r, c, Math.random() < 0.5 ? "✦" : "❤", 2);
      }
    }

    if (firstCleared) {
      addFloat(firstCleared[0], firstCleared[1], label ?? `+${formatNumber(gained)}`);
      if (nextCombo >= 2)
        addFloat(
          Math.max(0, firstCleared[0] - 1),
          firstCleared[1],
          `COMBO x${nextCombo}!`,
          "#e64b8a",
        );
      if (milestone) {
        addFloat(
          Math.max(0, firstCleared[0] - 2),
          firstCleared[1],
          `${milestone.label} +${formatNumber(milestone.bonus)}`,
          milestone.color,
        );
        if (milestone.label !== "FEVER BONUS")
          showCallout(
            "콤보 보너스!",
            `${milestone.label} +${formatNumber(milestone.bonus)}`,
            "combo",
          );
      }
      if (exp.specialsTriggered > 0)
        showCallout(
          "특수 효과 발동!",
          `${exp.specialsTriggered}개 효과가 연쇄로 터졌어요`,
          "special",
        );
      if (nextCombo === FEVER_TRIGGER_COMBO - 1 && exp.specialsTriggered === 0)
        showCallout("한 번 더!", "다음 매치면 FEVER", "combo");
      celebrateClear(firstCleared, cells, nextCombo, exp.specialsTriggered, feverOn);
    }

    setMatched(matchedSet);
    await sleep(280);
    b = collapseAndRefill(b, cleared, rngRef.current);
    setBoard(b);
    setMatched(new Set());
    await sleep(320);
    breakComboLater(nextCombo);
    return b;
  };

  /** Process all chained matches starting from a board. */
  const resolveMatches = async (
    startBoard: Cell[][],
    comboStart: number,
    options: { chargePang?: boolean } = {},
  ) => {
    let b = startBoard.map((row) => row.slice());
    let chainCombo = comboStart;
    let chains = 0;
    const shouldChargePang = options.chargePang ?? true;

    while (true) {
      const baseCleared = findMatches(b);
      if (!baseCleared.some((row) => row.some(Boolean))) break;
      let baseCells = 0;
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) if (baseCleared[r][c]) baseCells++;

      // Determine which group earns a special before clearing
      const groups = matchGroups(b, baseCleared);
      const specialsToPlace: { r: number; c: number; animal: Animal; special: Special }[] = [];
      for (const g of groups) {
        const sp = specialFromMatch(g.cells.length);
        if (sp !== "none") {
          const [sr, sc] = g.cells[Math.floor(g.cells.length / 2)];
          specialsToPlace.push({ r: sr, c: sc, animal: g.animal, special: sp });
        }
      }
      if (specialsToPlace.length > 0) {
        const bestSpecial = specialsToPlace.some((sp) => sp.special === "rainbow")
          ? "rainbow"
          : specialsToPlace[0].special;
        const smileCreates = specialsToPlace.filter((sp) => sp.special === "smile").length;
        const rainbowCreates = specialsToPlace.filter((sp) => sp.special === "rainbow").length;
        setRunStats((stats) => ({
          ...stats,
          specialCreates: stats.specialCreates + specialsToPlace.length,
          smileCreates: stats.smileCreates + smileCreates,
          rainbowCreates: stats.rainbowCreates + rainbowCreates,
        }));
        showCallout(
          `${specialName(bestSpecial)} 생성!`,
          specialDetail(bestSpecial),
          bestSpecial === "rainbow" ? "fever" : "special",
        );
        pulseBoard(bestSpecial === "rainbow" ? 320 : 220);
      }

      // Expand with specials and fever
      const feverOn = feverActiveRef.current;
      const exp = expandSpecials(b, baseCleared, feverOn, rngRef.current);
      const cleared = exp.cleared;
      let cells = 0;
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (cleared[r][c]) cells++;

      // increment combo & gauges
      chains++;
      chainCombo += 1;
      setCombo(chainCombo);
      setMaxCombo((m) => Math.max(m, chainCombo));
      setFeverGauge(((chainCombo % FEVER_TRIGGER_COMBO) / FEVER_TRIGGER_COMBO) * 100);
      if (chainCombo > 0 && chainCombo % FEVER_TRIGGER_COMBO === 0) {
        triggerFever();
      }

      const skillBonus =
        specialsToPlace.length * 600 + (groups.length >= 2 ? 800 : 0) + (chains >= 3 ? 500 : 0);
      const baseScore = cells * 30;
      const comboBonus = Math.floor(baseScore * (chainCombo - 1) * 0.5);
      const milestone = comboMilestone(chainCombo);
      const milestoneBonus = milestone?.bonus ?? 0;
      const feverMult = feverOn ? 2 : 1;
      const gained =
        (baseScore + comboBonus + exp.coinHits * 200 + skillBonus + milestoneBonus) * feverMult;
      addScore(gained);
      setRunStats((stats) => ({
        ...stats,
        matchedCells: stats.matchedCells + cells,
        specialTriggers: stats.specialTriggers + exp.specialsTriggered,
        feverClears: stats.feverClears + (feverOn ? cells : 0),
      }));
      if (exp.timeHits > 0) setTime((t) => Math.min(GAME_SECONDS + 10, t + 3 * exp.timeHits));
      pulseBoard(
        feverOn || exp.specialsTriggered > 0 || specialsToPlace.length > 0 || cells >= 6
          ? 300
          : 150,
      );
      vibrate(
        feverOn || exp.specialsTriggered > 0 || specialsToPlace.length > 0
          ? [14, 24, 36]
          : cells >= 6
            ? [12, 22]
            : 12,
      );

      // mark matched, render flash
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (cleared[r][c]) {
            const sp = b[r][c].special;
            if (sp === "coin") addParticle(r, c, "✨", 3);
            else if (sp === "time") addParticle(r, c, "⏱", 3);
            else if (sp !== "none") addParticle(r, c, "💥", 4);
            else if (Math.random() < 0.4) addParticle(r, c, Math.random() < 0.5 ? "✦" : "❤", 2);
          }
        }
      }
      // float text near a matched cell
      const firstCleared = (() => {
        for (let r = 0; r < ROWS; r++)
          for (let c = 0; c < COLS; c++) if (cleared[r][c]) return [r, c] as [number, number];
        return null;
      })();
      if (firstCleared) {
        addFloat(firstCleared[0], firstCleared[1], `+${formatNumber(gained)}`);
        if (chainCombo >= 2)
          addFloat(
            Math.max(0, firstCleared[0] - 1),
            firstCleared[1],
            `COMBO x${chainCombo}!`,
            "#e64b8a",
          );
        if (milestone) {
          addFloat(
            Math.max(0, firstCleared[0] - 2),
            firstCleared[1],
            `${milestone.label} +${formatNumber(milestone.bonus)}`,
            milestone.color,
          );
          if (milestone.label !== "FEVER BONUS")
            showCallout(
              "콤보 보너스!",
              `${milestone.label} +${formatNumber(milestone.bonus)}`,
              "combo",
            );
        }
        if (exp.specialsTriggered > 0)
          showCallout(
            "특수 효과 발동!",
            `${exp.specialsTriggered}개 효과가 연쇄로 터졌어요`,
            "special",
          );
        if (chainCombo === FEVER_TRIGGER_COMBO - 1 && exp.specialsTriggered === 0)
          showCallout("한 번 더!", "다음 매치면 FEVER", "combo");
        if (groups.length >= 2) addFloat(firstCleared[0], firstCleared[1], "DOUBLE!", "#e64b8a");
        else if (chains >= 3) addFloat(firstCleared[0], firstCleared[1], "CHAIN!", "#ff7a3d");
        celebrateClear(
          firstCleared,
          cells,
          chainCombo,
          exp.specialsTriggered + specialsToPlace.length,
          feverOn,
        );
      }

      // visually mark matched
      const matchedSet = new Set<number>();
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) if (cleared[r][c]) matchedSet.add(b[r][c].id);
      setMatched(matchedSet);

      await sleep(280);

      // place specials in cleared cells (those positions will be replaced after collapse — instead, we add to top after refill)
      // To attach a special, we keep the matched-position cell un-cleared but transform it.
      const transformedBoard = b.map((row, r) =>
        row.map((cell, c) => {
          const sp = specialsToPlace.find((s) => s.r === r && s.c === c);
          if (sp) return { id: cell.id, animal: sp.animal, special: sp.special } as Cell;
          return cell;
        }),
      );
      // mark positions where specials were placed as not cleared
      for (const sp of specialsToPlace) cleared[sp.r][sp.c] = false;

      b = collapseAndRefill(transformedBoard, cleared, rngRef.current);

      if (shouldChargePang && advancedSpecialsUnlocked && chains === 1) {
        chargePangGaugeFromMove(b, baseCells, specialsToPlace.length);
      }
      if (advancedSpecialsUnlocked && chains === 1)
        maybeDropBonusSpecial(b, chainCombo, specialsToPlace.length);

      setBoard(b);
      setMatched(new Set());
      await sleep(320);
    }

    // ensure board has moves
    if (!hasAnyMatch(b) && !findHint(b)) {
      // shuffle by recreating
      const nb = createBoard(rngRef.current);
      setBoard(nb);
    }
    if (chains > 0) breakComboLater(chainCombo);
    if (chains === 0) setCombo(0);
    return b;
  };

  const [matched, setMatched] = useState<Set<number>>(new Set());

  const activateSpecial = async (r: number, c: number) => {
    if (countdown !== null) return false;
    const piece = board[r]?.[c];
    if (!piece || !TAP_SPECIALS.has(piece.special)) return false;
    vibrate([12, 20, 28]);
    showCallout(`${specialName(piece.special)} 발동!`, specialDetail(piece.special), "special");
    setBusy(true);
    setSelected(null);
    setHint(null);
    const seed = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    seed[r][c] = true;
    const afterSpecial = await applyClear(
      board,
      seed,
      combo,
      piece.special === "bomb" ? "PANG!" : "RANDOM!",
    );
    await resolveMatches(afterSpecial, combo + 1, { chargePang: false });
    setBusy(false);
    return true;
  };

  const performSwap = async (from: [number, number], to: [number, number]) => {
    if (busy || phase !== "playing" || countdown !== null) return;
    lastMoveAt.current = Date.now();
    setHint(null);
    if (!adjacent(from, to)) return;
    const dir: ReplayMove["dir"] =
      to[0] < from[0] ? "up" : to[0] > from[0] ? "down" : to[1] < from[1] ? "left" : "right";
    replayMovesRef.current.push({
      r: from[0],
      c: from[1],
      dir,
      t: Math.max(0, Date.now() - (currentMatchRef.current?.startedAtMs ?? Date.now())),
    });
    setBusy(true);
    const before = board.map((row) => row.slice());
    swap(before, from, to);
    setBoard(before);
    await sleep(180);
    if (!hasAnyMatch(before)) {
      // swap back
      const back = before.map((row) => row.slice());
      swap(back, from, to);
      setBoard(back);
      pulseBoard(260);
      vibrate(28);
      addFloat(to[0], to[1], "MISS", "#c44");
      setRunStats((stats) => ({ ...stats, missCount: stats.missCount + 1 }));
      const nextHint = findHintMove(back);
      if (nextHint) {
        setHint(nextHint);
        addFloat(nextHint.from[0], nextHint.from[1], "TRY", "#26a7d8");
      }
      showCallout(
        nextHint ? "아까워요" : "매치 실패",
        nextHint ? "빛나는 두 블록을 밀어보세요" : "3개 이상 이어지는 방향으로 밀어보세요",
        "miss",
      );
      await sleep(180);
    } else {
      await resolveMatches(before, combo);
    }
    setSelected(null);
    setBusy(false);
  };

  const cellFromPointer = (event: ReactPointerEvent<HTMLDivElement>): [number, number] | null => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const col = Math.min(COLS - 1, Math.max(0, Math.floor((x / rect.width) * COLS)));
    const row = Math.min(ROWS - 1, Math.max(0, Math.floor((y / rect.height) * ROWS)));
    return [row, col];
  };

  const handleBoardPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || phase !== "playing" || countdown !== null) return;
    const from = cellFromPointer(event);
    if (!from) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      from,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      pointerId: event.pointerId,
      triggered: false,
    };
    setSelected(from);
    setHint(null);
    lastMoveAt.current = Date.now();
  };

  const handleBoardPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (
      !drag ||
      drag.pointerId !== event.pointerId ||
      drag.triggered ||
      busy ||
      phase !== "playing"
    )
      return;
    event.preventDefault();
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const threshold = Math.max(16, tile * 0.28);
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;

    const to: [number, number] = [...drag.from];
    if (Math.abs(dx) > Math.abs(dy)) to[1] += dx > 0 ? 1 : -1;
    else to[0] += dy > 0 ? 1 : -1;
    if (to[0] < 0 || to[0] >= ROWS || to[1] < 0 || to[1] >= COLS) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setSelected(null);
      return;
    }

    drag.triggered = true;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setSelected(null);
    void performSwap(drag.from, to);
  };

  const handleBoardPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setSelected(null);

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const threshold = Math.max(14, tile * 0.22);
    if (!drag.triggered && Math.max(Math.abs(dx), Math.abs(dy)) >= threshold) {
      const to: [number, number] = [...drag.from];
      if (Math.abs(dx) > Math.abs(dy)) to[1] += dx > 0 ? 1 : -1;
      else to[0] += dy > 0 ? 1 : -1;
      if (to[0] >= 0 && to[0] < ROWS && to[1] >= 0 && to[1] < COLS) {
        void performSwap(drag.from, to);
        return;
      }
    }

    if (!drag.triggered) {
      void activateSpecial(drag.from[0], drag.from[1]);
    }
  };

  const handleBoardPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setSelected(null);
  };

  const lastPang = async () => {
    setBusy(true);
    // detonate all specials by marking them cleared
    let b = board.map((row) => row.slice());
    const cleared = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    let any = false;
    let bonus = 0;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        if (b[r][c].special !== "none") {
          cleared[r][c] = true;
          any = true;
        }
      }
    if (any) {
      pulseBoard(420);
      const exp = expandSpecials(b, cleared, false, rngRef.current);
      let cells = 0;
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (exp.cleared[r][c]) cells++;
      bonus = cells * 50 + exp.coinHits * 200;
      addScore(bonus);
      setRunStats((stats) => ({ ...stats, lastPangBonus: stats.lastPangBonus + bonus }));
      showCallout("LAST PANG!", `남은 특수블록 보너스 +${formatNumber(bonus)}`, "fever");
      addFloat(3, 3, `LAST PANG! +${formatNumber(bonus)}`, "#e64b8a");
      const set = new Set<number>();
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) if (exp.cleared[r][c]) set.add(b[r][c].id);
      setMatched(set);
      await sleep(450);
      b = collapseAndRefill(b, exp.cleared, rngRef.current);
      setBoard(b);
      setMatched(new Set());
      await sleep(300);
    }
    // finalize
    const finalScore = scoreRef.current;
    const reward = resolveRunReward(
      finalScore,
      maxCombo,
      feverCount,
      runStats,
      missionCompletedRef.current,
      activeDailyQuest,
      progress,
      currentDayKey,
    );
    setProgress(reward.profile);
    saveProgress(reward.profile);
    setLastReward(reward.summary);
    if (reward.summary.dailyCompleted) {
      showCallout("오늘의 도전 완료!", `${reward.summary.stars}별을 받았어요`, "fever");
    }
    if (reward.summary.unlockedPang) {
      showCallout("PANG 해금!", "LV3부터 팡이와 보너스 블록이 등장해요", "special");
    }
    if (finalScore <= 0 && player) {
      const refundedPlayer = await refundHeart(player);
      setPlayer(refundedPlayer);
      setRankingMessage("0점은 랭킹에 저장되지 않아요. 하트가 돌아왔어요.");
      setRankingStatus("local");
    }
    const matchSession = currentMatchRef.current;
    const queuedVersus = currentVersusRef.current;
    let matchAccepted = finalScore > 0;
    if (matchSession) {
      try {
        const finishResult = await finishMatch({
          matchId: matchSession.matchId,
          playerUid: player?.uid,
          mode: matchSession.mode,
          seed: matchSession.seed,
          startedAtMs: matchSession.startedAtMs,
          score: finalScore,
          maxCombo,
          matchedCells: runStats.matchedCells,
          specialTriggers: runStats.specialTriggers,
          feverCount,
          rewards: {
            xp: reward.summary.xp,
            stars: reward.summary.stars,
          },
          replay: replayMovesRef.current,
        });
        matchAccepted = finishResult.accepted;
      } catch {
        matchAccepted = false;
      }
    }
    void logTelemetryEvent("match_finish", {
      mode: matchSession?.mode ?? "rush",
      score: finalScore,
      maxCombo,
      accepted: matchAccepted,
    });
    setBest((prevBest) => {
      if (finalScore > prevBest) {
        localStorage.setItem("anipang-best", String(finalScore));
        setNewRecord(true);
        return finalScore;
      }
      return prevBest;
    });
    if (player && finalScore > 0 && matchAccepted) {
      void recordRunProgress(player, reward.profile, {
        matchId: matchSession?.matchId,
        score: finalScore,
        matchedCells: runStats.matchedCells,
        maxCombo,
        specialTriggers: runStats.specialTriggers,
        feverCount,
      })
        .then(async (nextPlayer) => {
          let resolvedPlayer = nextPlayer;
          if (queuedVersus && matchSession?.mode === "versus") {
            try {
              const result = await finishVersus(nextPlayer, matchSession.matchId, finalScore);
              resolvedPlayer = result.profile;
              setVersusResult(result);
              setRankingMessage(
                result.result === "win"
                  ? `대전 승리! RP +${result.rpDelta} · 별 +${result.rewards.stars}`
                  : `대전 패배 · RP ${result.rpDelta} · 별 +${result.rewards.stars}`,
              );
              setRankingStatus(result.result === "win" ? "online" : "local");
            } catch {
              setRankingMessage("대전 결과 확정에 실패했어요. 잠시 후 다시 확인해주세요.");
              setRankingStatus("error");
            }
          }
          await recordGuildContribution(resolvedPlayer, finalScore).catch(() => null);
          setPlayer(resolvedPlayer);
          const nextProgress = progressFromPlayer(resolvedPlayer);
          setProgress(nextProgress);
          saveProgress(nextProgress);
          setDailyMissionStatus(await getDailyMissionStatus(resolvedPlayer));
          setWeeklyMissionStatus(await getWeeklyMissionStatus(resolvedPlayer));
        })
        .catch(() => {
          setRankingMessage("보상 저장에 실패했어요. Firebase Functions 배포 상태를 확인해주세요.");
          setRankingStatus("error");
        });
    } else if (player && finalScore > 0 && !matchAccepted) {
      setRankingMessage("매치 검증에 실패해서 보상과 랭킹 등록이 보류됐어요.");
      setRankingStatus("error");
    }
    setPhase("ended");
    setBusy(false);
    void refreshLeaderboards();
  };

  const submitScore = async () => {
    const runId = currentRunIdRef.current;
    if (scoreSaved || savingScoreRef.current || savedRunIdRef.current === runId) return;
    savingScoreRef.current = true;
    const cleanName = sanitizeNickname(nickname);
    setNickname(cleanName);
    localStorage.setItem(NICKNAME_KEY, cleanName);
    setRankingMessage("기록 저장 중...");
    setRankingStatus("saving");

    try {
      const savedEntry = await saveScore({
        runId,
        playerUid: player?.uid,
        nickname: cleanName,
        score,
        maxCombo,
        feverCount,
      });
      savedRunIdRef.current = runId;
      setScoreSaved(true);
      if (savedEntry.savedOnline) {
        setRankingStatus("online");
        setRankingMessage("온라인 주간 랭킹에 기록됐어요!");
      } else {
        setRankingStatus("local");
        setRankingMessage(
          player?.authMode === "firebase" && isFirebaseConfigured
            ? "온라인 연결이 불안정해서 로컬 기록으로 저장됐어요."
            : "로컬 주간 랭킹에 기록됐어요.",
        );
      }
      await refreshLeaderboards();
    } catch {
      setRankingStatus("error");
      setRankingMessage("등록에 실패했어요. Firebase 설정을 확인해주세요.");
    } finally {
      savingScoreRef.current = false;
    }
  };

  useEffect(() => {
    if (phase !== "ended" || scoreSaved || score <= 0) return;
    void submitScore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, score, scoreSaved]);

  const share = async () => {
    const text = `[ANI PANG PARTY] 점수 ${formatNumber(score)}점 · 최대 콤보 ${maxCombo} 🎉`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "ANI PANG PARTY", text });
      } catch {
        return;
      }
    } else {
      try {
        await navigator.clipboard.writeText(text);
        alert("결과가 복사되었어요!");
      } catch {
        alert(text);
      }
    }
  };

  const activePlayer = useMemo(
    () => (player ? recoverHearts(player, heartTick) : null),
    [player, heartTick],
  );
  const visibleProfileStats =
    profileStats ?? (activePlayer ? buildPlayerStats(activePlayer) : null);
  const nextHeartAt = activePlayer ? getNextHeartAt(activePlayer) : null;
  const nextHeartLabel = nextHeartAt ? formatHeartWait(nextHeartAt - heartTick) : "FULL";
  const todayLeader = leaderboards.today[0];
  const weeklyLeader = leaderboards.weekly[0];
  const isOnlinePlayer = activePlayer?.authMode === "firebase";
  const canReplay = !playerLoading && (activePlayer?.hearts ?? 0) > 0;
  const heartCountLabel = playerLoading ? "..." : `${activePlayer?.hearts ?? 0}/${MAX_HEARTS}`;
  const heartSummaryLabel = nextHeartAt ? `다음 하트 ${nextHeartLabel}` : `하트 ${heartCountLabel}`;
  const accountProviderText = activePlayer
    ? activePlayer.linkedProviders
        .map((provider) => accountProviderLabels[provider])
        .filter(Boolean)
        .join(" · ")
    : "준비 중";
  const lobbyPlayerLine =
    heartMessage || rankingMessage || `별 ${formatNumber(progress.stars)} · ${heartSummaryLabel}`;
  const canStartFromLobby = !playerLoading && (activePlayer?.hearts ?? 0) > 0;
  const advancedSpecialsUnlocked = progress.level >= 3;
  const activePangBombs = countSpecial(board, "bomb");
  const currentMissionProgress = Math.min(
    mission.goal,
    missionProgress(mission, runStats, feverCount, maxCombo),
  );
  const currentMissionPercent = Math.min(100, (currentMissionProgress / mission.goal) * 100);
  const boosterDisabled = phase !== "playing" || busy || countdown !== null;
  const scoreGap = Math.max(0, best - score);
  const nextComboTarget = Math.max(FEVER_TRIGGER_COMBO, maxCombo + 1);
  const replayButtonText = !canReplay ? "하트 충전 중" : newRecord ? "기록 굳히기" : "바로 재도전";
  const resultTeaseTag = newRecord ? "NEW BEST" : scoreGap > 0 ? "NEXT TARGET" : "NEXT RUN";
  const resultTeaseTitle =
    score <= 0
      ? "첫 매치만 터뜨리면 기록이 시작돼요"
      : newRecord
        ? "방금 감각으로 한 번 더 올려봐요"
        : scoreGap > 0
          ? `최고 기록까지 ${formatNumber(scoreGap)}점`
          : "다음 판은 콤보 기록 갱신";
  const resultTeaseDetail =
    maxCombo < FEVER_TRIGGER_COMBO
      ? `${FEVER_TRIGGER_COMBO}콤보면 피버가 열려요`
      : feverCount <= 0
        ? "피버 한 번만 터뜨리면 점수가 크게 뛰어요"
        : `다음 목표 x${nextComboTarget} 콤보`;

  if (phase === "start") {
    return (
      <main className="classic-shell">
        <div className="classic-phone">
          <section className="classic-screen lobby-page">
            <div className="lobby-shell">
              <header className="lobby-topbar">
                <div className="lobby-brand">
                  <span>PANGPANG</span>
                  <strong>RUSH</strong>
                </div>
                <div className="lobby-actions">
                  <button className="help-button" onClick={showOnboarding}>
                    게임 방법
                  </button>
                  <button className="help-button" onClick={() => setAccountOpen(true)}>
                    계정
                  </button>
                  <div className="lobby-version">v1</div>
                </div>
              </header>

              {lobbyRoute === "home" ? (
                <section className="lobby-card">
                  <div className="lobby-hero-unit">
                    <div className="lobby-season">{season?.title ?? "60 SEC COMBO RUSH"}</div>
                    <div className="lobby-stage-badge">
                      STAGE {Math.min(stageProgress?.currentStage ?? 1, 12)}
                    </div>
                    <img src={partyImg} alt="party mascots" className="lobby-mascots" />
                    <h1>
                      ANI PANG <span>PARTY</span>
                    </h1>
                    <p>콤보를 이어가고 피버를 터뜨려 랭킹에 도전하세요.</p>
                  </div>

                  <div className="lobby-meta">
                    <ResultCell label="BEST" value={formatNumber(best)} />
                    <ResultCell label="HEART" value={heartCountLabel} />
                    <ResultCell label="LEVEL" value={String(progress.level)} />
                  </div>

                  <div className="lobby-profile">
                    <div className="profile-label">PLAYER</div>
                    <div className="profile-control">
                      <input
                        className="nickname-input"
                        value={nickname}
                        maxLength={12}
                        onChange={(event) => setNickname(event.target.value)}
                        aria-label="플레이어 이름"
                        placeholder="이름을 입력하세요"
                      />
                      <button
                        className="btn-secondary btn-small whitespace-nowrap"
                        onClick={savePlayerName}
                      >
                        등록
                      </button>
                    </div>
                    <div className="player-service-row">
                      <span>
                        {activePlayer?.authMode === "firebase"
                          ? accountProviderText
                          : "로컬 게스트"}
                      </span>
                      <button type="button" onClick={() => setAccountOpen(true)}>
                        {activePlayer
                          ? `ID ${activePlayer.uid.slice(-6).toUpperCase()}`
                          : "준비 중"}
                      </button>
                    </div>
                    <div className="mt-2 text-xs opacity-70 min-h-4">{lobbyPlayerLine}</div>
                  </div>

                  <button
                    className="rank-preview-button"
                    onClick={() => {
                      setRankingScope("weekly");
                      void refreshLeaderboards();
                      setRankingOpen(true);
                    }}
                  >
                    <span>
                      <strong>RANKING</strong>
                      <small>
                        {weeklyLeader ? `주간 1위 ${weeklyLeader.nickname}` : "주간 순위 도전"}
                      </small>
                    </span>
                    <b>{weeklyLeader ? formatNumber(weeklyLeader.score) : "보기"}</b>
                  </button>

                  <div className={`lobby-mission-card daily-quest-card ${dailyDone ? "done" : ""}`}>
                    <span>{dailyDone ? "DONE" : activeDailyQuest.label}</span>
                    <strong>{dailyDone ? "오늘 도전 완료" : activeDailyQuest.title}</strong>
                    <small>
                      {dailyDone
                        ? `${progress.streak}일 연속 · 별 ${formatNumber(progress.stars)}`
                        : `보상 +${activeDailyQuest.rewardStars}별 · 다음 LV ${currentLevelPercent}%`}
                    </small>
                  </div>

                  <div className="lobby-menu-grid" aria-label="로비 메뉴">
                    <button
                      type="button"
                      onClick={() => {
                        setLiveOpsMessage("");
                        setLobbyRoute("profile");
                      }}
                    >
                      <span>PROFILE</span>
                      <strong>프로필</strong>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLiveOpsMessage("");
                        setLobbyRoute("world");
                      }}
                    >
                      <span>WORLD</span>
                      <strong>월드</strong>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLiveOpsMessage("");
                        setLobbyRoute("daily");
                      }}
                    >
                      <span>DAILY</span>
                      <strong>출석</strong>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLiveOpsMessage("");
                        setLobbyRoute("pass");
                      }}
                    >
                      <span>PASS</span>
                      <strong>패스</strong>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLiveOpsMessage("");
                        setLobbyRoute("shop");
                      }}
                    >
                      <span>SHOP</span>
                      <strong>상점</strong>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLiveOpsMessage("");
                        setSocialMessage("");
                        setLobbyRoute("social");
                      }}
                    >
                      <span>SOCIAL</span>
                      <strong>친구</strong>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLiveOpsMessage("");
                        setLobbyRoute("collection");
                      }}
                    >
                      <span>DEX</span>
                      <strong>도감</strong>
                    </button>
                  </div>

                  <button
                    className="btn-primary w-full"
                    onClick={() => void startGame()}
                    disabled={!canStartFromLobby}
                  >
                    {canStartFromLobby ? "게임 시작" : "하트 충전 중"}
                  </button>
                </section>
              ) : (
                <LobbyMetaScreen
                  route={lobbyRoute}
                  season={season}
                  progress={progress}
                  player={activePlayer}
                  shopItems={shopItems}
                  dailyStatus={dailyStatus}
                  weeklyMissionStatus={weeklyMissionStatus}
                  seasonPassStatus={seasonPassStatus}
                  stageProgress={stageProgress}
                  profileStats={visibleProfileStats}
                  profileStatsLoading={profileStatsLoading}
                  friendCode={friendCode}
                  friends={friends}
                  friendInput={friendInput}
                  guildState={guildState}
                  guildNameInput={guildNameInput}
                  guildJoinInput={guildJoinInput}
                  socialLoading={socialLoading}
                  socialMessage={socialMessage}
                  versusStarting={versusStarting}
                  characterDex={characterDex}
                  best={best}
                  liveOpsMessage={liveOpsMessage}
                  canStart={canStartFromLobby}
                  onBack={() => setLobbyRoute("home")}
                  onPlay={() => void startGame()}
                  onClaimDaily={() => void handleClaimDaily()}
                  onClaimWeeklyMission={(missionId) => void handleClaimWeeklyMission(missionId)}
                  onClaimPassReward={(level, track) =>
                    void handleClaimSeasonPassReward(level, track)
                  }
                  onClaimStage={() => void handleClearStageReward()}
                  onOpenShop={() => {
                    setLiveOpsMessage("");
                    setLobbyRoute("shop");
                  }}
                  onPurchaseItem={(item) => void handlePurchaseItem(item)}
                  onClaimAdReward={() => void handleClaimAdReward()}
                  onSetMainCharacter={(animal) => void handleSetMainCharacter(animal)}
                  onLevelUpCharacter={(character) => void handleLevelUpCharacter(character)}
                  onFriendInputChange={(value) =>
                    setFriendInput(value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())
                  }
                  onGuildNameChange={setGuildNameInput}
                  onGuildJoinInputChange={(value) => setGuildJoinInput(value.trim())}
                  onInviteFriend={() => void handleInviteFriend()}
                  onRemoveFriend={(friendId) => void handleRemoveFriend(friendId)}
                  onBlockFriend={(friendId) => void handleBlockFriend(friendId)}
                  onReportFriend={(friendId) => void handleReportFriend(friendId)}
                  onStartVersus={() => void startGame("versus")}
                  onCreateGuild={() => void handleCreateGuild()}
                  onJoinGuild={() => void handleJoinGuild()}
                  onLeaveGuild={() => void handleLeaveGuild()}
                  onKickGuildMember={(memberId) => void handleKickGuildMember(memberId)}
                />
              )}

              {rankingOpen && (
                <RankingModal
                  leaderboards={leaderboards}
                  scope={rankingScope}
                  onScopeChange={setRankingScope}
                  audience={rankingAudience}
                  onAudienceChange={setRankingAudience}
                  loading={leaderboardLoading}
                  online={isOnlinePlayer}
                  onClose={() => setRankingOpen(false)}
                />
              )}
              {accountOpen && (
                <AccountModal
                  player={activePlayer}
                  message={accountMessage}
                  busyProvider={accountBusy}
                  restoreBusy={accountRestoreBusy}
                  restoreCode={accountRestoreCode}
                  restoreInput={accountRestoreInput}
                  deleteArmed={accountDeleteArmed}
                  notificationPrefs={notificationPrefs}
                  onLink={(provider) => void handleLinkAccount(provider)}
                  onCopyId={() => void copyPlayerId()}
                  onToggleNotification={(topic) => void handleNotificationToggle(topic)}
                  onCreateRestoreCode={() => void handleCreateRestoreCode()}
                  onRestoreInputChange={(value) =>
                    setAccountRestoreInput(value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())
                  }
                  onRestoreProfile={() => void handleRestoreProfile()}
                  onExportData={() => void handleExportAccountData()}
                  onDeleteAccount={() => void handleDeleteAccount()}
                  onClose={() => {
                    setAccountOpen(false);
                    setAccountMessage("");
                    setAccountDeleteArmed(false);
                  }}
                />
              )}
              {onboardingOpen && (
                <OnboardingModal
                  step={onboardingStep}
                  onStepChange={handleOnboardingStepChange}
                  onNext={advanceOnboarding}
                  onClose={closeOnboarding}
                />
              )}
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="classic-shell classic-play-shell">
      <div className="classic-phone classic-game-phone">
        <section className="classic-screen game-page min-h-screen w-full flex flex-col items-center justify-start py-4 px-3 gap-3">
          {/* Title bar */}
          <div className="game-topbar w-full max-w-md flex items-center justify-between">
            <div
              className="text-2xl font-extrabold tracking-tight"
              style={{ color: "var(--brown)" }}
            >
              🐾 ANI PANG <span style={{ color: "var(--orange)" }}>PARTY</span>
            </div>
            <div className="text-xs px-2 py-1 rounded-full hud-card">v1</div>
          </div>

          {/* HUD */}
          <div className="game-hud w-full max-w-md grid grid-cols-3 gap-2">
            <Stat
              label="TIME"
              value={`${time}s`}
              accent={time <= 10 ? "var(--destructive)" : "var(--mint)"}
              pulse={time <= 10 && phase === "playing"}
            />
            <Stat label="SCORE" value={formatNumber(score)} accent="var(--orange)" />
            <Stat label="COMBO" value={`x${combo}`} accent="var(--pink)" pulse={combo >= 2} />
          </div>

          <div className={`rush-strip ${combo >= 2 ? "active" : ""} ${feverActive ? "fever" : ""}`}>
            <div>
              <strong>
                {feverActive ? "FEVER TIME!" : combo >= 2 ? `COMBO x${combo}` : "COMBO READY"}
              </strong>
              <span>
                {feverActive
                  ? `상하좌우 블록까지 함께 터져요 · ${feverLeft}s`
                  : combo >= 2
                    ? "게이지가 사라지기 전에 이어가세요"
                    : "연속 매치로 점수를 키워보세요"}
              </span>
            </div>
            <div className="rush-meter" aria-hidden="true">
              <i style={{ width: `${feverActive ? 100 : combo >= 1 ? comboWindow : 0}%` }} />
            </div>
          </div>

          <div className={`mission-strip ${missionCompleted ? "completed" : ""}`}>
            <div className="mission-copy">
              <b>{mission.label}</b>
              <strong>{missionCompleted ? "미션 완료!" : mission.title}</strong>
              <span>
                {missionCompleted ? `보너스 +${formatNumber(mission.bonus)}` : mission.detail}
              </span>
            </div>
            <div className="mission-state">
              <em>
                {currentMissionProgress}/{mission.goal}
              </em>
              <div className="mission-meter" aria-hidden="true">
                <i style={{ width: `${missionCompleted ? 100 : currentMissionPercent}%` }} />
              </div>
            </div>
          </div>

          {callout && (
            <div className={`skill-callout ${callout.tone}`} key={callout.id}>
              <strong>{callout.title}</strong>
              <span>{callout.detail}</span>
            </div>
          )}

          {/* Board */}
          <div
            className={`game-board-frame relative w-full max-w-md ${feverActive ? "fever-frame" : ""} ${time <= 10 && phase === "playing" ? "last-rush-frame" : ""} ${boardShake ? "board-shake" : ""}`}
            style={{
              background: "white",
              borderRadius: 24,
              padding: 10,
              boxShadow:
                "0 6px 0 oklch(0.55 0.10 50 / 0.15), 0 18px 36px oklch(0.55 0.10 50 / 0.12)",
              border: "3px solid oklch(0.88 0.04 70)",
            }}
          >
            {(feverActive || feverNotice) && <div className="fever-ribbon">FEVER!</div>}
            <div
              ref={boardRef}
              className={`game-board relative w-full ${feverActive ? "fever-board" : ""}`}
              style={{
                aspectRatio: "1 / 1",
                borderRadius: 16,
                background: "oklch(0.96 0.04 80)",
                overflow: "hidden",
              }}
              onPointerDown={handleBoardPointerDown}
              onPointerMove={handleBoardPointerMove}
              onPointerUp={handleBoardPointerUp}
              onPointerCancel={handleBoardPointerCancel}
            >
              {countdown !== null && (
                <div className="ready-countdown" aria-live="polite">
                  <span>READY</span>
                  <strong>{countdown}</strong>
                  <em>밀어서 시작!</em>
                </div>
              )}
              {/* tiles */}
              {board.map((row, r) =>
                row.map((cell, c) => {
                  const isSelected = selected && selected[0] === r && selected[1] === c;
                  const isHintFrom = hint && hint.from[0] === r && hint.from[1] === c;
                  const isHintTo = hint && hint.to[0] === r && hint.to[1] === c;
                  const isHint = isHintFrom || isHintTo;
                  const isMatched = matched.has(cell.id);
                  return (
                    <div
                      key={cell.id}
                      className={`tile animal-${cell.animal} ${cell.special !== "none" ? "powered" : ""} ${isSelected ? "selected" : ""} ${isHint ? "hint" : ""} ${isHintFrom ? "hint-from" : ""} ${isHintTo ? "hint-to" : ""} ${isMatched ? "matched" : ""} ${cell.special === "smile" ? "smile" : ""} ${cell.special === "rainbow" ? "rainbow" : ""} ${cell.special === "bomb" ? "bomb" : ""} ${cell.special === "coin" ? "coin" : ""} ${cell.special === "time" ? "time" : ""}`}
                      style={{ width: tile, height: tile, top: r * tile, left: c * tile }}
                    >
                      <img src={animalImg[cell.animal]} alt={cell.animal} draggable={false} />
                      {isHintFrom && hint ? <span className="hint-arrow">{hint.label}</span> : null}
                      {specialBadge(cell.special)}
                    </div>
                  );
                }),
              )}
              {/* floats */}
              {floats.map((f) => (
                <div
                  key={f.id}
                  className="float-text"
                  style={{
                    left: f.x,
                    top: f.y,
                    color: f.color,
                    transform: "translate(-50%,-50%)",
                    fontSize: Math.max(14, tile * 0.35),
                  }}
                >
                  {f.text}
                </div>
              ))}
              {particles.map((p) => (
                <div
                  key={p.id}
                  className="particle"
                  style={
                    {
                      left: p.x,
                      top: p.y,
                      transform: "translate(-50%,-50%)",
                      fontSize: Math.max(16, tile * 0.5) * p.scale,
                      "--particle-dx": `${p.dx}px`,
                      "--particle-dy": `${p.dy}px`,
                      "--particle-rotate": `${p.rotate}deg`,
                      "--particle-delay": `${p.delay}ms`,
                    } as CSSProperties
                  }
                >
                  {p.emoji}
                </div>
              ))}
            </div>
          </div>

          {/* Bottom gauges */}
          <div className="game-gauges w-full max-w-md grid grid-cols-2 gap-2">
            {advancedSpecialsUnlocked ? (
              <Gauge
                label={`PANG ${activePangBombs}/${MAX_ACTIVE_PANG_BOMBS}`}
                value={pangGauge}
                color="var(--orange)"
              />
            ) : (
              <LockedGauge label="PANG" note="LV3 OPEN" />
            )}
            <Gauge
              label="FEVER"
              value={feverActive ? 100 : feverGauge}
              color="var(--yellow)"
              pulsing={feverActive}
            />
          </div>

          <div className="boost-tray" aria-label="부스터 슬롯">
            <div className="boost-tray-head">
              <span>BOOST</span>
              <strong>러시 보조 슬롯</strong>
            </div>
            <div className="boost-buttons">
              <BoosterButton
                label="HINT"
                detail="힌트"
                count={boosters.hint}
                tone="mint"
                disabled={boosterDisabled || boosters.hint <= 0}
                onClick={() => handleBooster("hint")}
              />
              <BoosterButton
                label="MIX"
                detail="섞기"
                count={boosters.shuffle}
                tone="gold"
                disabled={boosterDisabled || boosters.shuffle <= 0}
                onClick={() => handleBooster("shuffle")}
              />
              <BoosterButton
                label="+3s"
                detail="시간"
                count={boosters.timePlus}
                tone="pink"
                disabled={boosterDisabled || boosters.timePlus <= 0}
                onClick={() => handleBooster("timePlus")}
              />
            </div>
          </div>

          {/* End overlay */}
          {phase === "ended" && (
            <Overlay>
              <div
                className="text-2xl font-extrabold"
                style={{ color: newRecord ? "var(--orange)" : "var(--brown)" }}
              >
                {newRecord ? "🏆 최고 기록!" : "⏰ 시간 끝!"}
              </div>
              <div className={`result-tease-card ${newRecord ? "record" : ""}`}>
                <span>{resultTeaseTag}</span>
                <strong>{resultTeaseTitle}</strong>
                <small>{resultTeaseDetail}</small>
              </div>
              <div className="result-actions primary-result-actions">
                <button
                  className="btn-primary"
                  onClick={() => void startGame()}
                  disabled={!canReplay}
                >
                  {replayButtonText}
                </button>
                <button className="btn-secondary" onClick={showStart}>
                  로비
                </button>
              </div>
              {activeVersus && (
                <div className={`versus-result-card ${versusResult?.result ?? "pending"}`}>
                  <div className="versus-result-head">
                    <span>VERSUS</span>
                    <strong>
                      {versusResult
                        ? versusResult.result === "win"
                          ? "대전 승리"
                          : "대전 패배"
                        : "결과 확정 중"}
                    </strong>
                    <small>
                      {versusResult?.opponent.nickname ?? activeVersus.opponent.nickname}
                    </small>
                  </div>
                  <div className="versus-score-row">
                    <div>
                      <span>내 점수</span>
                      <strong>{formatNumber(versusResult?.playerScore ?? score)}</strong>
                    </div>
                    <div>
                      <span>상대 목표</span>
                      <strong>
                        {formatNumber(
                          versusResult?.opponentScore ?? activeVersus.opponent.scoreTarget,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>RP</span>
                      <strong>
                        {versusResult
                          ? `${versusResult.rpDelta > 0 ? "+" : ""}${versusResult.rpDelta}`
                          : "..."}
                      </strong>
                    </div>
                  </div>
                </div>
              )}
              {lastReward && (
                <div
                  className={`reward-summary ${lastReward.dailyCompleted ? "daily-complete" : ""}`}
                >
                  <div>
                    <span>성장</span>
                    <strong>+{lastReward.xp} XP</strong>
                  </div>
                  <div>
                    <span>별</span>
                    <strong>+{lastReward.stars}</strong>
                  </div>
                  <div>
                    <span>{lastReward.dailyCompleted ? "연속" : "레벨"}</span>
                    <strong>
                      {lastReward.dailyCompleted
                        ? `${lastReward.streak}일`
                        : `LV ${progress.level}`}
                    </strong>
                  </div>
                  {(lastReward.dailyCompleted || lastReward.leveledUp) && (
                    <p>{lastReward.leveledUp ? "레벨 업!" : "오늘의 도전 완료!"}</p>
                  )}
                </div>
              )}
              {lastReward?.unlockedPang && (
                <div className="unlock-banner" role="status" aria-live="polite">
                  <span>LV3 OPEN</span>
                  <strong>PANG 해금!</strong>
                  <small>팡이와 보너스 블록이 다음 판부터 등장해요.</small>
                </div>
              )}
              <div className="result-main-stats">
                <ResultCell label="점수" value={formatNumber(score)} />
                <ResultCell label="최고" value={formatNumber(best)} />
                <ResultCell label="최대 콤보" value={`x${maxCombo}`} />
                <ResultCell
                  label="남은 하트"
                  value={`${activePlayer?.hearts ?? 0}/${MAX_HEARTS}`}
                />
              </div>
              <details className="result-details">
                <summary>상세 기록</summary>
                <div className="result-breakdown">
                  <div>
                    <span>터뜨린 블록</span>
                    <strong>{formatNumber(runStats.matchedCells)}</strong>
                  </div>
                  <div>
                    <span>특수 생성</span>
                    <strong>{formatNumber(runStats.specialCreates)}</strong>
                  </div>
                  <div>
                    <span>특수 발동</span>
                    <strong>{formatNumber(runStats.specialTriggers)}</strong>
                  </div>
                  <div>
                    <span>미션 보너스</span>
                    <strong>{formatNumber(runStats.missionBonus)}</strong>
                  </div>
                  <div>
                    <span>라스트팡</span>
                    <strong>{formatNumber(runStats.lastPangBonus)}</strong>
                  </div>
                </div>
              </details>
              <div className="w-full max-w-xs mx-auto mb-4">
                <div className="result-player">{sanitizeNickname(nickname)}님의 기록</div>
                <div className={`ranking-status ${rankingStatus}`} aria-live="polite">
                  {rankingMessage ||
                    (score > 0 ? "기록 저장 중..." : "1점 이상부터 랭킹에 저장돼요.")}
                </div>
              </div>
              <div className="result-secondary-actions">
                <button
                  className="btn-secondary"
                  onClick={() => {
                    setRankingScope("weekly");
                    void refreshLeaderboards();
                    setRankingOpen(true);
                  }}
                >
                  랭킹
                </button>
                <button className="btn-secondary" onClick={share}>
                  공유
                </button>
              </div>
            </Overlay>
          )}

          {rankingOpen && (
            <RankingModal
              leaderboards={leaderboards}
              scope={rankingScope}
              onScopeChange={setRankingScope}
              audience={rankingAudience}
              onAudienceChange={setRankingAudience}
              loading={leaderboardLoading}
              online={isOnlinePlayer}
              onClose={() => setRankingOpen(false)}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function LobbyMetaScreen({
  route,
  season,
  progress,
  player,
  shopItems,
  dailyStatus,
  weeklyMissionStatus,
  seasonPassStatus,
  stageProgress,
  profileStats,
  profileStatsLoading,
  friendCode,
  friends,
  friendInput,
  guildState,
  guildNameInput,
  guildJoinInput,
  socialLoading,
  socialMessage,
  versusStarting,
  characterDex,
  best,
  liveOpsMessage,
  canStart,
  onBack,
  onPlay,
  onClaimDaily,
  onClaimWeeklyMission,
  onClaimPassReward,
  onClaimStage,
  onOpenShop,
  onPurchaseItem,
  onClaimAdReward,
  onSetMainCharacter,
  onLevelUpCharacter,
  onFriendInputChange,
  onGuildNameChange,
  onGuildJoinInputChange,
  onInviteFriend,
  onRemoveFriend,
  onBlockFriend,
  onReportFriend,
  onStartVersus,
  onCreateGuild,
  onJoinGuild,
  onLeaveGuild,
  onKickGuildMember,
}: {
  route: Exclude<LobbyRoute, "home">;
  season: SeasonCurrent | null;
  progress: ProgressProfile;
  player: PlayerProfile | null;
  shopItems: ShopItem[];
  dailyStatus: DailyCheckinStatus | null;
  weeklyMissionStatus: WeeklyMissionStatus | null;
  seasonPassStatus: SeasonPassStatus | null;
  stageProgress: StageProgress | null;
  profileStats: PlayerStats | null;
  profileStatsLoading: boolean;
  friendCode: string;
  friends: FriendEntry[];
  friendInput: string;
  guildState: GuildState | null;
  guildNameInput: string;
  guildJoinInput: string;
  socialLoading: boolean;
  socialMessage: string;
  versusStarting: boolean;
  characterDex: CharacterDexEntry[];
  best: number;
  liveOpsMessage: string;
  canStart: boolean;
  onBack: () => void;
  onPlay: () => void;
  onClaimDaily: () => void;
  onClaimWeeklyMission: (missionId: string) => void;
  onClaimPassReward: (level: number, track: SeasonPassTrack) => void;
  onClaimStage: () => void;
  onOpenShop: () => void;
  onPurchaseItem: (item: ShopItem) => void;
  onClaimAdReward: () => void;
  onSetMainCharacter: (animal: CharacterId) => void;
  onLevelUpCharacter: (character: CharacterDexEntry) => void;
  onFriendInputChange: (value: string) => void;
  onGuildNameChange: (value: string) => void;
  onGuildJoinInputChange: (value: string) => void;
  onInviteFriend: () => void;
  onRemoveFriend: (friendId: string) => void;
  onBlockFriend: (friendId: string) => void;
  onReportFriend: (friendId: string) => void;
  onStartVersus: () => void;
  onCreateGuild: () => void;
  onJoinGuild: () => void;
  onLeaveGuild: () => void;
  onKickGuildMember: (memberId: string) => void;
}) {
  const meta = {
    profile: { title: "프로필", label: "PLAYER" },
    world: { title: "월드", label: "WORLD MAP" },
    daily: { title: "출석", label: "DAILY" },
    pass: { title: "패스", label: "SEASON PASS" },
    shop: { title: "상점", label: "SHOP" },
    collection: { title: "도감", label: "CHARACTER" },
    social: { title: "친구", label: "SOCIAL" },
  } satisfies Record<Exclude<LobbyRoute, "home">, { title: string; label: string }>;
  const { title, label } = meta[route];

  return (
    <section className="meta-panel">
      <header className="meta-panel-head">
        <button type="button" className="meta-back" onClick={onBack} aria-label="로비로 돌아가기">
          ‹
        </button>
        <div>
          <span>{label}</span>
          <strong>{title}</strong>
        </div>
        <em>{season?.title ?? "SEASON"}</em>
      </header>

      {liveOpsMessage && <div className="meta-toast">{liveOpsMessage}</div>}

      {route === "profile" && (
        <ProfilePanel
          player={player}
          stats={profileStats}
          loading={profileStatsLoading}
          characters={characterDex}
        />
      )}
      {route === "world" && (
        <WorldPanel
          progress={stageProgress}
          best={best}
          canStart={canStart}
          onPlay={onPlay}
          onClaimStage={onClaimStage}
        />
      )}
      {route === "daily" && (
        <DailyPanel
          status={dailyStatus}
          weeklyStatus={weeklyMissionStatus}
          player={player}
          onClaimDaily={onClaimDaily}
          onClaimWeeklyMission={onClaimWeeklyMission}
        />
      )}
      {route === "pass" && (
        <PassPanel
          status={seasonPassStatus}
          player={player}
          onClaimReward={onClaimPassReward}
          onOpenShop={onOpenShop}
        />
      )}
      {route === "shop" && (
        <ShopPanel
          items={shopItems}
          progress={progress}
          player={player}
          onPurchaseItem={onPurchaseItem}
          onClaimAdReward={onClaimAdReward}
        />
      )}
      {route === "social" && (
        <SocialPanel
          code={friendCode}
          friends={friends}
          input={friendInput}
          currentUserId={player?.uid ?? ""}
          guildState={guildState}
          guildNameInput={guildNameInput}
          guildJoinInput={guildJoinInput}
          loading={socialLoading}
          message={socialMessage}
          canStart={canStart}
          versusStarting={versusStarting}
          onInputChange={onFriendInputChange}
          onGuildNameChange={onGuildNameChange}
          onGuildJoinInputChange={onGuildJoinInputChange}
          onInviteFriend={onInviteFriend}
          onRemoveFriend={onRemoveFriend}
          onBlockFriend={onBlockFriend}
          onReportFriend={onReportFriend}
          onStartVersus={onStartVersus}
          onCreateGuild={onCreateGuild}
          onJoinGuild={onJoinGuild}
          onLeaveGuild={onLeaveGuild}
          onKickGuildMember={onKickGuildMember}
        />
      )}
      {route === "collection" && (
        <CollectionPanel
          characters={characterDex}
          player={player}
          onSetMainCharacter={onSetMainCharacter}
          onLevelUpCharacter={onLevelUpCharacter}
        />
      )}
    </section>
  );
}

function ProfilePanel({
  player,
  stats,
  loading,
  characters,
}: {
  player: PlayerProfile | null;
  stats: PlayerStats | null;
  loading: boolean;
  characters: CharacterDexEntry[];
}) {
  const mainCharacter = stats?.mainCharacter ?? player?.mainCharacter ?? "puppy";
  const character = characters.find((item) => item.animal === mainCharacter);
  const xpInLevel = stats ? stats.xp % XP_PER_LEVEL : 0;
  const xpPercent = Math.min(100, Math.round((xpInLevel / XP_PER_LEVEL) * 100));
  const badges = [
    {
      label: "FIRST",
      title: stats && stats.totalPlays > 0 ? "첫 플레이" : "도전 대기",
      active: Boolean(stats && stats.totalPlays > 0),
    },
    {
      label: "COMBO",
      title: stats && stats.maxCombo >= 8 ? "콤보 장인" : "콤보 연습",
      active: Boolean(stats && stats.maxCombo >= 8),
    },
    {
      label: "SPECIAL",
      title: stats && stats.totalSpecials >= 20 ? "스페셜 마스터" : "스페셜 수집",
      active: Boolean(stats && stats.totalSpecials >= 20),
    },
  ];

  if (!stats) {
    return (
      <div className="meta-stack">
        <div className="profile-empty-card">
          <strong>{loading ? "통계 불러오는 중" : "계정 준비 중"}</strong>
          <span>
            {player ? "프로필 데이터를 정리하고 있어요." : "플레이어 정보를 먼저 준비해요."}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="meta-stack">
      <div className="profile-hero-card">
        <div className="profile-avatar">
          <img
            src={animalImg[mainCharacter]}
            alt={character?.name ?? mainCharacter}
            draggable={false}
          />
          <span>MAIN</span>
        </div>
        <div className="profile-hero-copy">
          <span>{accountProviderLabels[stats.authProvider] ?? "PLAYER"}</span>
          <strong>{stats.nickname}</strong>
          <small>
            {stats.tier} · RP {formatNumber(stats.rp)} · {character?.name ?? "대표 동물"}
          </small>
        </div>
        <em>LV {stats.level}</em>
      </div>

      <div className="profile-level-card">
        <div>
          <span>LEVEL PROGRESS</span>
          <strong>
            {formatNumber(xpInLevel)} / {formatNumber(XP_PER_LEVEL)} XP
          </strong>
        </div>
        <div className="pass-meter" aria-hidden="true">
          <i style={{ width: `${xpPercent}%` }} />
        </div>
      </div>

      <div className="profile-stat-grid">
        <ProfileStatTile label="최고 점수" value={formatNumber(stats.bestScore)} />
        <ProfileStatTile label="평균 점수" value={formatNumber(stats.averageScore)} />
        <ProfileStatTile label="플레이" value={`${formatNumber(stats.totalPlays)}회`} />
        <ProfileStatTile label="최대 콤보" value={`x${formatNumber(stats.maxCombo)}`} />
        <ProfileStatTile label="매치 수" value={formatNumber(stats.totalMatches)} />
        <ProfileStatTile label="특수 발동" value={formatNumber(stats.totalSpecials)} />
      </div>

      <div className="profile-wallet-row">
        <span>별 {formatNumber(stats.stars)}</span>
        <span>코인 {formatNumber(stats.coins)}</span>
        <span>
          하트 {stats.hearts}/{MAX_HEARTS}
        </span>
        <span>{vipStatusLabel(stats.vipUntil)}</span>
      </div>

      <div className="profile-badge-row" aria-label="업적">
        {badges.map((badge) => (
          <div className={`profile-badge ${badge.active ? "active" : ""}`} key={badge.label}>
            <span>{badge.label}</span>
            <strong>{badge.title}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileStatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="profile-stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WorldPanel({
  progress,
  best,
  canStart,
  onPlay,
  onClaimStage,
}: {
  progress: StageProgress | null;
  best: number;
  canStart: boolean;
  onPlay: () => void;
  onClaimStage: () => void;
}) {
  const currentStage = progress?.currentStage ?? 1;
  const earnedStars = stageStarsFromScore(best);
  const totalStars = Object.values(progress?.stars || {}).reduce(
    (total, value) => total + value,
    0,
  );
  const stages = Array.from({ length: 12 }, (_, index) => index + 1);

  return (
    <div className="meta-stack">
      <div className="world-summary">
        <ResultCell label="STAGE" value={String(Math.min(currentStage, 12))} />
        <ResultCell label="BEST" value={formatNumber(best)} />
        <ResultCell label="STAR" value={String(totalStars)} />
      </div>

      <div className="stage-grid" aria-label="월드 스테이지">
        {stages.map((stage) => {
          const stars = progress?.stars[String(stage)] || 0;
          const locked = stage > currentStage;
          const active = stage === Math.min(currentStage, 12);
          return (
            <div
              key={stage}
              className={`stage-node ${locked ? "locked" : ""} ${active ? "active" : ""}`}
            >
              <strong>{stage}</strong>
              <span>{"★".repeat(stars).padEnd(3, "☆")}</span>
            </div>
          );
        })}
      </div>

      <div className="meta-action-row">
        <button
          type="button"
          className="meta-action-button primary"
          onClick={onPlay}
          disabled={!canStart}
        >
          도전
        </button>
        <button
          type="button"
          className="meta-action-button"
          onClick={onClaimStage}
          disabled={earnedStars <= 0}
        >
          별 저장
        </button>
      </div>
    </div>
  );
}

function DailyPanel({
  status,
  weeklyStatus,
  player,
  onClaimDaily,
  onClaimWeeklyMission,
}: {
  status: DailyCheckinStatus | null;
  weeklyStatus: WeeklyMissionStatus | null;
  player: PlayerProfile | null;
  onClaimDaily: () => void;
  onClaimWeeklyMission: (missionId: string) => void;
}) {
  const claimed = new Set(status?.claimed || []);

  return (
    <div className="meta-stack">
      <div className="daily-strip">
        <span>DAY {status?.currentDay ?? "-"}</span>
        <strong>{status?.claimedToday ? "수령 완료" : "오늘 보상"}</strong>
        <em>{player ? `별 ${formatNumber(player.stars)}` : "계정 준비 중"}</em>
      </div>

      <div className="daily-reward-grid">
        {(status?.rewards || []).map((reward) => (
          <div
            key={reward.day}
            className={`daily-reward ${claimed.has(reward.day) ? "claimed" : ""} ${
              status?.currentDay === reward.day ? "current" : ""
            }`}
          >
            <span>{reward.day}</span>
            <strong>{reward.label}</strong>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="meta-action-button primary"
        onClick={onClaimDaily}
        disabled={!player || status?.claimedToday}
      >
        {status?.claimedToday ? "수령 완료" : "받기"}
      </button>

      <div className="weekly-mission-card">
        <div className="weekly-mission-head">
          <span>WEEKLY</span>
          <strong>주간 미션</strong>
          <em>{weeklyStatus ? `${weeklyStatus.missions.length}개` : "준비 중"}</em>
        </div>
        <div className="weekly-mission-list">
          {(weeklyStatus?.missions || []).map((item) => {
            const percent = Math.min(100, Math.round((item.progress / item.mission.goal) * 100));
            return (
              <div className="weekly-mission-row" key={item.mission.id}>
                <div>
                  <span>{item.mission.title}</span>
                  <strong>
                    {formatNumber(item.progress)} / {formatNumber(item.mission.goal)}
                  </strong>
                </div>
                <button
                  type="button"
                  onClick={() => onClaimWeeklyMission(item.mission.id)}
                  disabled={!player || item.claimed || !item.completed}
                >
                  {item.claimed ? "완료" : `+${item.rewards.stars}`}
                </button>
                <i aria-hidden="true">
                  <b style={{ width: `${percent}%` }} />
                </i>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PassPanel({
  status,
  player,
  onClaimReward,
  onOpenShop,
}: {
  status: SeasonPassStatus | null;
  player: PlayerProfile | null;
  onClaimReward: (level: number, track: SeasonPassTrack) => void;
  onOpenShop: () => void;
}) {
  if (!status) {
    return (
      <div className="meta-stack">
        <div className="pass-hero">
          <div className="pass-hero-head">
            <span>COLOR RUSH</span>
            <strong>컬러 러시 패스</strong>
            <em>로딩 중</em>
          </div>
          <div className="pass-progress-row">
            <span>LV -</span>
            <strong>계정 준비 중</strong>
          </div>
          <div className="pass-meter" aria-hidden="true">
            <i style={{ width: "0%" }} />
          </div>
        </div>
      </div>
    );
  }

  const xpPercent = Math.min(100, Math.round((status.xp / status.xpToNext) * 100));

  return (
    <div className="meta-stack">
      <div className="pass-hero">
        <div className="pass-hero-head">
          <span>{status?.season.theme ?? "COLOR RUSH"}</span>
          <strong>{status.season.title}</strong>
          <em>{status.premium ? "프리미엄 보유" : "프리미엄 잠김"}</em>
        </div>
        <div className="pass-progress-row">
          <span>LV {status?.currentLevel ?? "-"}</span>
          <strong>{`${status.xp} / ${status.xpToNext} XP`}</strong>
        </div>
        <div className="pass-meter" aria-hidden="true">
          <i style={{ width: `${xpPercent}%` }} />
        </div>
      </div>

      {!status.premium && (
        <button
          type="button"
          className="meta-action-button pass-premium-button"
          onClick={onOpenShop}
        >
          프리미엄 패스 보기
        </button>
      )}

      <div className="pass-track-list">
        {status.tiers.map((tier) => (
          <div
            className={`pass-tier-row ${tier.unlocked ? "unlocked" : "locked"}`}
            key={tier.level}
          >
            <div className="pass-level-chip">{tier.level}</div>
            <PassRewardButton
              tier={tier}
              track="free"
              player={player}
              status={status}
              onClaimReward={onClaimReward}
            />
            <PassRewardButton
              tier={tier}
              track="premium"
              player={player}
              status={status}
              onClaimReward={onClaimReward}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function PassRewardButton({
  tier,
  track,
  player,
  status,
  onClaimReward,
}: {
  tier: SeasonPassStatus["tiers"][number];
  track: SeasonPassTrack;
  player: PlayerProfile | null;
  status: SeasonPassStatus;
  onClaimReward: (level: number, track: SeasonPassTrack) => void;
}) {
  const claimed = tier.claimed[track];
  const levelLocked = !tier.unlocked;
  const premiumLocked = track === "premium" && !status.premium;
  const canClaim = Boolean(player && !claimed && !levelLocked && !premiumLocked);
  const buttonText = claimed ? "완료" : levelLocked ? "잠김" : premiumLocked ? "프리미엄" : "받기";
  const reward = tier[track];

  return (
    <button
      type="button"
      className={`pass-reward ${track} ${claimed ? "claimed" : ""}`}
      onClick={() => onClaimReward(tier.level, track)}
      disabled={!canClaim}
    >
      <span>{track === "free" ? "FREE" : "PREMIUM"}</span>
      <strong>{reward.label}</strong>
      <small>{buttonText}</small>
    </button>
  );
}

function ShopPanel({
  items,
  progress,
  player,
  onPurchaseItem,
  onClaimAdReward,
}: {
  items: ShopItem[];
  progress: ProgressProfile;
  player: PlayerProfile | null;
  onPurchaseItem: (item: ShopItem) => void;
  onClaimAdReward: () => void;
}) {
  const stars = player?.stars ?? progress.stars;
  const orderedItems = [...items].sort((a, b) => a.category.localeCompare(b.category));

  return (
    <div className="meta-stack">
      <div className="shop-wallet">
        <span>WALLET</span>
        <strong>별 {formatNumber(stars)}</strong>
        <em>{vipStatusLabel(player?.vipUntil)}</em>
      </div>

      <div className="ad-reward-row">
        <div>
          <span>AD REWARD</span>
          <strong>광고 보고 하트 받기</strong>
          <small>보상형 광고 완료 후 서버에서 지급돼요.</small>
        </div>
        <button type="button" onClick={onClaimAdReward} disabled={!player}>
          +하트
        </button>
      </div>

      <div className="shop-list">
        {orderedItems.map((item) => (
          <div className="shop-row" key={item.id}>
            <div>
              <span>{shopCategoryLabel(item.category)}</span>
              <strong>{item.name}</strong>
              <small>{item.desc}</small>
            </div>
            <em>{item.tag ?? shopPriceLabel(item)}</em>
            <button type="button" onClick={() => onPurchaseItem(item)} disabled={!player}>
              {item.currency === "iap" ? "확인" : "구매"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SocialPanel({
  code,
  friends,
  input,
  currentUserId,
  guildState,
  guildNameInput,
  guildJoinInput,
  loading,
  message,
  canStart,
  versusStarting,
  onInputChange,
  onGuildNameChange,
  onGuildJoinInputChange,
  onInviteFriend,
  onRemoveFriend,
  onBlockFriend,
  onReportFriend,
  onStartVersus,
  onCreateGuild,
  onJoinGuild,
  onLeaveGuild,
  onKickGuildMember,
}: {
  code: string;
  friends: FriendEntry[];
  input: string;
  currentUserId: string;
  guildState: GuildState | null;
  guildNameInput: string;
  guildJoinInput: string;
  loading: boolean;
  message: string;
  canStart: boolean;
  versusStarting: boolean;
  onInputChange: (value: string) => void;
  onGuildNameChange: (value: string) => void;
  onGuildJoinInputChange: (value: string) => void;
  onInviteFriend: () => void;
  onRemoveFriend: (friendId: string) => void;
  onBlockFriend: (friendId: string) => void;
  onReportFriend: (friendId: string) => void;
  onStartVersus: () => void;
  onCreateGuild: () => void;
  onJoinGuild: () => void;
  onLeaveGuild: () => void;
  onKickGuildMember: (memberId: string) => void;
}) {
  return (
    <div className="meta-stack">
      <div className="social-code-card">
        <div>
          <span>MY CODE</span>
          <strong>{code || "------"}</strong>
        </div>
        <em>{loading ? "SYNC" : `${friends.length}명`}</em>
      </div>

      <div className="versus-entry-card">
        <div>
          <span>VERSUS</span>
          <strong>라이벌 대전</strong>
          <small>내 점수와 상대 목표 점수로 RP를 겨뤄요.</small>
        </div>
        <button type="button" onClick={onStartVersus} disabled={!canStart || versusStarting}>
          {versusStarting ? "매칭 중" : "대전 찾기"}
        </button>
      </div>

      <div className="social-invite-row">
        <input
          value={input}
          maxLength={6}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder="친구 코드"
          aria-label="친구 코드"
        />
        <button type="button" onClick={onInviteFriend} disabled={loading || input.length !== 6}>
          추가
        </button>
      </div>

      {message && <div className="meta-toast">{message}</div>}

      <GuildPanel
        state={guildState}
        currentUserId={currentUserId}
        nameInput={guildNameInput}
        joinInput={guildJoinInput}
        loading={loading}
        onNameChange={onGuildNameChange}
        onJoinInputChange={onGuildJoinInputChange}
        onCreateGuild={onCreateGuild}
        onJoinGuild={onJoinGuild}
        onLeaveGuild={onLeaveGuild}
        onKickMember={onKickGuildMember}
      />

      <div className="friend-list">
        {friends.length ? (
          friends.map((friend) => (
            <article className="friend-card" key={friend.id}>
              <div className="friend-avatar">
                <img src={animalImg[friend.animal]} alt={friend.nickname} draggable={false} />
                <i className={friend.isOnline ? "online" : ""} />
              </div>
              <div>
                <strong>{friend.nickname}</strong>
                <span>
                  BEST {formatNumber(friend.bestScore)}
                  {friend.lastSeen ? ` · ${new Date(friend.lastSeen).toLocaleDateString()}` : ""}
                </span>
              </div>
              <div className="friend-actions">
                <button type="button" onClick={() => onReportFriend(friend.id)} disabled={loading}>
                  신고
                </button>
                <button type="button" onClick={() => onBlockFriend(friend.id)} disabled={loading}>
                  차단
                </button>
                <button type="button" onClick={() => onRemoveFriend(friend.id)} disabled={loading}>
                  삭제
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="friend-empty">
            <strong>{loading ? "친구 불러오는 중" : "친구 코드로 추가"}</strong>
            <span>서로의 6자리 코드를 입력하면 친구 랭킹 기반이 준비돼요.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function GuildPanel({
  state,
  currentUserId,
  nameInput,
  joinInput,
  loading,
  onNameChange,
  onJoinInputChange,
  onCreateGuild,
  onJoinGuild,
  onLeaveGuild,
  onKickMember,
}: {
  state: GuildState | null;
  currentUserId: string;
  nameInput: string;
  joinInput: string;
  loading: boolean;
  onNameChange: (value: string) => void;
  onJoinInputChange: (value: string) => void;
  onCreateGuild: () => void;
  onJoinGuild: () => void;
  onLeaveGuild: () => void;
  onKickMember: (memberId: string) => void;
}) {
  const guild = state?.guild ?? null;
  const boss = state?.boss ?? guild?.boss ?? null;
  const canManageMembers = Boolean(guild && currentUserId && guild.ownerId === currentUserId);
  const bossProgress = boss
    ? Math.min(100, Math.round(((boss.hpMax - boss.hp) / boss.hpMax) * 100))
    : 0;

  if (!guild) {
    return (
      <div className="guild-empty-card">
        <div>
          <span>GUILD</span>
          <strong>길드 만들기</strong>
          <small>친구들과 주간 보스 점수를 함께 쌓아요.</small>
        </div>
        <div className="guild-form-row">
          <input
            value={nameInput}
            maxLength={16}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="길드 이름"
            aria-label="길드 이름"
          />
          <button type="button" onClick={onCreateGuild} disabled={loading || nameInput.length < 2}>
            생성
          </button>
        </div>
        <div className="guild-form-row">
          <input
            value={joinInput}
            maxLength={32}
            onChange={(event) => onJoinInputChange(event.target.value)}
            placeholder="길드 ID"
            aria-label="길드 ID"
          />
          <button type="button" onClick={onJoinGuild} disabled={loading || !joinInput}>
            가입
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="guild-card">
      <div className="guild-hero">
        <div>
          <span>MY GUILD</span>
          <strong>{guild.name}</strong>
          <small>
            LV {guild.level} · 멤버 {guild.memberCount}명 · ID {guild.id}
          </small>
        </div>
        <button type="button" onClick={onLeaveGuild} disabled={loading}>
          나가기
        </button>
      </div>
      <div className="guild-boss-card">
        <div className="guild-boss-icon">BOSS</div>
        <div>
          <span>WEEKLY BOSS</span>
          <strong>레인보우 드래곤</strong>
          <small>
            {formatNumber(guild.weeklyScore)} 기여 · HP {formatNumber(boss?.hp ?? 0)}
          </small>
        </div>
        <em>{bossProgress}%</em>
        <div className="guild-boss-meter">
          <i style={{ width: `${bossProgress}%` }} />
        </div>
      </div>
      <div className="guild-member-list">
        {(state?.members ?? []).slice(0, 4).map((member) => (
          <div className="guild-member-row" key={member.id}>
            <img src={animalImg[member.animal]} alt={member.nickname} draggable={false} />
            <div>
              <strong>{member.nickname}</strong>
              <span>
                {member.role === "leader" ? "길드장" : "멤버"} · 기여도{" "}
                {formatNumber(member.weeklyContribution)}
              </span>
            </div>
            {canManageMembers && member.id !== currentUserId && (
              <button type="button" onClick={() => onKickMember(member.id)} disabled={loading}>
                내보내기
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CollectionPanel({
  characters,
  player,
  onSetMainCharacter,
  onLevelUpCharacter,
}: {
  characters: CharacterDexEntry[];
  player: PlayerProfile | null;
  onSetMainCharacter: (animal: CharacterId) => void;
  onLevelUpCharacter: (character: CharacterDexEntry) => void;
}) {
  return (
    <div className="collection-grid">
      {characters.map((character) => {
        const isMain = player?.mainCharacter === character.animal;
        const cost = characterLevelCost(character);
        return (
          <article
            className={`collection-card ${character.unlocked ? "" : "locked"} ${
              isMain ? "main" : ""
            }`}
            key={character.animal}
          >
            <div className="collection-portrait">
              <img src={animalImg[character.animal]} alt={character.name} draggable={false} />
              <span>{character.rarity}</span>
            </div>
            <div className="collection-copy">
              <strong>{character.name}</strong>
              <small>{character.role}</small>
              <p>{character.skill}</p>
            </div>
            <div className="collection-stats">
              <span>LV {character.level}</span>
              <span>친밀도 {character.affinity}</span>
            </div>
            <div className="collection-actions">
              <button
                type="button"
                onClick={() => onSetMainCharacter(character.animal)}
                disabled={!character.unlocked || isMain}
              >
                {isMain ? "대표" : "대표"}
              </button>
              <button
                type="button"
                onClick={() => onLevelUpCharacter(character)}
                disabled={!character.unlocked || !player}
              >
                {cost}별
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  pulse,
}: {
  label: string;
  value: string;
  accent: string;
  pulse?: boolean;
}) {
  return (
    <div className={`hud-card text-center ${pulse ? "combo-pop" : ""}`}>
      <div className="text-[10px] font-bold tracking-widest opacity-60">{label}</div>
      <div className="text-base font-extrabold" style={{ color: accent }}>
        {value}
      </div>
    </div>
  );
}

function Gauge({
  label,
  value,
  color,
  pulsing,
}: {
  label: string;
  value: number;
  color: string;
  pulsing?: boolean;
}) {
  return (
    <div className="hud-card">
      <div className="flex justify-between text-[10px] font-bold tracking-widest opacity-70">
        <span>{label}</span>
        <span>{Math.round(value)}%</span>
      </div>
      <div className="gauge mt-1">
        <div
          style={{
            width: `${Math.min(100, value)}%`,
            background: color,
            animation: pulsing ? "sparkle-pulse 0.6s infinite" : undefined,
          }}
        />
      </div>
    </div>
  );
}

function LockedGauge({ label, note }: { label: string; note: string }) {
  return (
    <div className="hud-card locked-gauge">
      <div className="flex justify-between text-[10px] font-bold tracking-widest opacity-70">
        <span>{label}</span>
        <span>{note}</span>
      </div>
      <div className="gauge mt-1">
        <div />
      </div>
    </div>
  );
}

function BoosterButton({
  label,
  detail,
  count,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  detail: string;
  count: number;
  tone: "mint" | "gold" | "pink";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`booster-button ${tone}`}
      disabled={disabled}
      onClick={onClick}
      aria-label={`${detail} 부스터 ${count}개 남음`}
    >
      <span>{label}</span>
      <strong>{detail}</strong>
      <em>{count}</em>
    </button>
  );
}

function ResultCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud-card text-center">
      <div className="text-[10px] font-bold tracking-widest opacity-60">{label}</div>
      <div className="text-lg font-extrabold" style={{ color: "var(--orange)" }}>
        {value}
      </div>
    </div>
  );
}

function Leaderboard({
  scores,
  loading,
  scope,
  online,
}: {
  scores: LeaderboardEntry[];
  loading: boolean;
  scope: LeaderboardScope;
  online: boolean;
}) {
  const topScores = scores.slice(0, 20);
  return (
    <div className="leaderboard-box">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-extrabold tracking-widest" style={{ color: "var(--brown)" }}>
          {scope === "today"
            ? "TODAY RANKING"
            : scope === "weekly"
              ? "WEEKLY RANKING"
              : "ALL RANKING"}
        </div>
        <div className="text-[10px] opacity-60">{online ? "ONLINE" : "LOCAL"}</div>
      </div>
      {loading ? (
        <div className="text-xs opacity-60 py-4">불러오는 중...</div>
      ) : topScores.length ? (
        <div className="space-y-1">
          {topScores.map((entry, index) => (
            <div className="leaderboard-row" key={`${entry.id ?? entry.nickname}-${index}`}>
              <span className="rank">{index + 1}</span>
              <span className="name">{entry.nickname}</span>
              <span className="combo">x{entry.maxCombo}</span>
              <strong>{formatNumber(entry.score)}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs opacity-60 py-4">
          {scope === "today" ? "오늘 첫 기록을 남겨보세요." : "첫 기록을 남겨보세요."}
        </div>
      )}
    </div>
  );
}

function RankingModal({
  leaderboards,
  scope,
  onScopeChange,
  audience,
  onAudienceChange,
  loading,
  online,
  onClose,
}: {
  leaderboards: Record<LeaderboardScope, LeaderboardEntry[]>;
  scope: LeaderboardScope;
  onScopeChange: (scope: LeaderboardScope) => void;
  audience: LeaderboardAudience;
  onAudienceChange: (audience: LeaderboardAudience) => void;
  loading: boolean;
  online: boolean;
  onClose: () => void;
}) {
  const scores = leaderboards[scope];
  return (
    <div className="ranking-modal-backdrop" role="dialog" aria-modal="true" aria-label="랭킹">
      <div className="ranking-modal">
        <div className="ranking-modal-head">
          <div>
            <strong>RANKING</strong>
            <span>{online ? (audience === "friends" ? "FRIENDS" : "ONLINE") : "LOCAL"}</span>
          </div>
          <button className="ranking-close" onClick={onClose} aria-label="랭킹 닫기">
            ×
          </button>
        </div>
        <div className="ranking-tabs audience-tabs" role="tablist" aria-label="랭킹 대상">
          <button
            className={`ranking-tab ${audience === "global" ? "active" : ""}`}
            role="tab"
            aria-selected={audience === "global"}
            onClick={() => onAudienceChange("global")}
          >
            전체
          </button>
          <button
            className={`ranking-tab ${audience === "friends" ? "active" : ""}`}
            role="tab"
            aria-selected={audience === "friends"}
            onClick={() => onAudienceChange("friends")}
          >
            친구
          </button>
        </div>
        <div className="ranking-tabs" role="tablist" aria-label="랭킹 범위">
          <button
            className={`ranking-tab ${scope === "today" ? "active" : ""}`}
            role="tab"
            aria-selected={scope === "today"}
            onClick={() => onScopeChange("today")}
          >
            오늘
          </button>
          <button
            className={`ranking-tab ${scope === "weekly" ? "active" : ""}`}
            role="tab"
            aria-selected={scope === "weekly"}
            onClick={() => onScopeChange("weekly")}
          >
            주간
          </button>
          <button
            className={`ranking-tab ${scope === "all" ? "active" : ""}`}
            role="tab"
            aria-selected={scope === "all"}
            onClick={() => onScopeChange("all")}
          >
            전체
          </button>
        </div>
        <Leaderboard scores={scores} loading={loading} scope={scope} online={online} />
      </div>
    </div>
  );
}

function AccountModal({
  player,
  message,
  busyProvider,
  restoreBusy,
  restoreCode,
  restoreInput,
  deleteArmed,
  notificationPrefs,
  onLink,
  onCopyId,
  onToggleNotification,
  onCreateRestoreCode,
  onRestoreInputChange,
  onRestoreProfile,
  onExportData,
  onDeleteAccount,
  onClose,
}: {
  player: PlayerProfile | null;
  message: string;
  busyProvider: AccountProviderKey | null;
  restoreBusy: boolean;
  restoreCode: string;
  restoreInput: string;
  deleteArmed: boolean;
  notificationPrefs: NotificationPreferences | null;
  onLink: (provider: AccountProviderKey) => void;
  onCopyId: () => void;
  onToggleNotification: (topic?: NotificationTopic) => void;
  onCreateRestoreCode: () => void;
  onRestoreInputChange: (value: string) => void;
  onRestoreProfile: () => void;
  onExportData: () => void;
  onDeleteAccount: () => void;
  onClose: () => void;
}) {
  const linked = new Set(player?.linkedProviders ?? ["anonymous"]);
  const providerSummary = player
    ? (player.linkedProviders || ["anonymous"])
        .map((provider) => accountProviderLabels[provider])
        .filter(Boolean)
        .join(" · ")
    : "준비 중";
  const prefs = notificationPrefs ?? { pushEnabled: true, topics: [] };
  const notificationTopics: { topic: NotificationTopic; label: string }[] = [
    { topic: "heart_full", label: "하트" },
    { topic: "friend_score", label: "친구" },
    { topic: "daily_reminder", label: "출석" },
    { topic: "season_ending", label: "시즌" },
  ];

  return (
    <div className="ranking-modal-backdrop" role="dialog" aria-modal="true" aria-label="계정">
      <div className="ranking-modal account-modal">
        <div className="ranking-modal-head">
          <div>
            <strong>ACCOUNT</strong>
            <span>{providerSummary}</span>
          </div>
          <button className="ranking-close" onClick={onClose} aria-label="계정 닫기">
            ×
          </button>
        </div>

        <div className="account-summary">
          <span>USER ID</span>
          <button type="button" onClick={onCopyId} disabled={!player}>
            {player ? player.uid.slice(-10).toUpperCase() : "준비 중"}
          </button>
        </div>

        <div className="account-link-list">
          {accountLinkOptions.map((option) => {
            const isLinked = linked.has(option.providerId);
            return (
              <button
                type="button"
                key={option.key}
                className={`account-link-button ${isLinked ? "linked" : ""}`}
                disabled={!player || busyProvider !== null || isLinked}
                onClick={() => onLink(option.key)}
              >
                <span>{option.label}</span>
                <strong>
                  {isLinked ? "연결됨" : busyProvider === option.key ? "연결 중..." : "연동"}
                </strong>
              </button>
            );
          })}
        </div>

        <div className="account-notification-panel">
          <div className="account-notification-head">
            <div>
              <span>PUSH</span>
              <strong>{prefs.pushEnabled ? "알림 켜짐" : "알림 꺼짐"}</strong>
            </div>
            <button type="button" onClick={() => onToggleNotification()} disabled={!player}>
              {prefs.pushEnabled ? "끄기" : "켜기"}
            </button>
          </div>
          <div className="account-topic-row">
            {notificationTopics.map((item) => {
              const active = prefs.topics.includes(item.topic);
              return (
                <button
                  type="button"
                  key={item.topic}
                  className={active ? "active" : ""}
                  onClick={() => onToggleNotification(item.topic)}
                  disabled={!player || !prefs.pushEnabled}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="account-restore-panel">
          <div>
            <span>RESTORE</span>
            <strong>{restoreCode || "다른 기기 복원"}</strong>
          </div>
          <button type="button" onClick={onCreateRestoreCode} disabled={!player || restoreBusy}>
            {restoreBusy && !restoreInput ? "처리 중" : "코드 만들기"}
          </button>
          <div className="account-restore-input">
            <input
              value={restoreInput}
              maxLength={6}
              onChange={(event) => onRestoreInputChange(event.target.value)}
              placeholder="6자리 코드"
              aria-label="복원 코드"
            />
            <button
              type="button"
              onClick={onRestoreProfile}
              disabled={!player || restoreBusy || restoreInput.length !== 6}
            >
              복원
            </button>
          </div>
        </div>

        <p className="account-note">
          소셜 계정 연동이 가장 안전해요. 복원 코드는 기존 기기에서 만들고 10분 안에 새 기기에서
          입력하세요.
        </p>
        <button
          type="button"
          className="account-export-button"
          onClick={onExportData}
          disabled={!player || busyProvider !== null || restoreBusy}
        >
          계정 데이터 내보내기
        </button>
        <button
          type="button"
          className={`account-danger-button ${deleteArmed ? "armed" : ""}`}
          onClick={onDeleteAccount}
          disabled={!player || busyProvider !== null || restoreBusy}
        >
          {deleteArmed ? "정말 삭제" : "계정 삭제"}
        </button>
        {message && <div className="account-message">{message}</div>}
      </div>
    </div>
  );
}

function OnboardingModal({
  step,
  onStepChange,
  onNext,
  onClose,
}: {
  step: number;
  onStepChange: (step: number) => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const current = onboardingSteps[step];
  const isLast = step === onboardingSteps.length - 1;

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="게임 방법">
      <section className="onboarding-card">
        <div className="onboarding-head">
          <div>
            <span>HOW TO PLAY</span>
            <strong>{current.label}</strong>
          </div>
          <button className="onboarding-skip" onClick={onClose}>
            건너뛰기
          </button>
        </div>

        <OnboardingVisual step={step} />

        <div className="onboarding-copy">
          <h2>{current.title}</h2>
          <p>{current.detail}</p>
          <div className="onboarding-tips">
            {current.tips.map((tip) => (
              <span key={tip}>{tip}</span>
            ))}
          </div>
        </div>

        <div className="onboarding-dots" aria-label="온보딩 단계">
          {onboardingSteps.map((item, index) => (
            <button
              key={item.label}
              className={index === step ? "active" : ""}
              onClick={() => onStepChange(index)}
              aria-label={`${index + 1}단계 보기`}
            />
          ))}
        </div>

        <div className="onboarding-actions">
          <button
            className="btn-secondary"
            onClick={() => onStepChange(Math.max(0, step - 1))}
            disabled={step === 0}
          >
            이전
          </button>
          <button className="btn-primary" onClick={onNext}>
            {isLast ? "로비로 가기" : "다음"}
          </button>
        </div>
      </section>
    </div>
  );
}

function OnboardingVisual({ step }: { step: number }) {
  if (step === 0) {
    const animals: Animal[] = [
      "cat",
      "puppy",
      "bear",
      "rabbit",
      "puppy",
      "panda",
      "chick",
      "puppy",
      "cat",
    ];
    return (
      <div className="onboarding-visual">
        <div className="onboarding-board">
          {animals.map((animal, index) => (
            <div className={index === 4 || index === 7 ? "moving" : ""} key={`${animal}-${index}`}>
              <img src={animalImg[animal]} alt="" draggable={false} />
            </div>
          ))}
        </div>
        <div className="drag-cue">밀어서 3개 만들기</div>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="onboarding-visual">
        <div className="combo-demo">
          <div>
            <span>COMBO</span>
            <strong>x4</strong>
          </div>
          <div className="combo-demo-meter">
            <i />
          </div>
          <b>다음 매치면 FEVER!</b>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-visual">
      <div className="special-demo">
        <div>
          <img src={animalImg.cat} alt="" draggable={false} />
          <span className="special-badge special-smile">4</span>
          <strong>4매치</strong>
        </div>
        <div>
          <img src={animalImg.panda} alt="" draggable={false} />
          <span className="special-badge special-rainbow">5</span>
          <strong>5매치</strong>
        </div>
        <div>
          <img src={animalImg.bear} alt="" draggable={false} />
          <span className="special-badge special-bomb">P</span>
          <strong>LV3</strong>
        </div>
      </div>
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="result-overlay">
      <div className="result-modal">{children}</div>
    </div>
  );
}
