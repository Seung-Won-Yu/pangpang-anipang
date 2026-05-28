import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";
import { createMatchSeed, type MatchStartResult } from "./matchSession";
import {
  persistPlayerProfile,
  type CharacterId,
  type PlayerProfile,
  type PlayerTier,
} from "./player";

const LOCAL_VERSUS_KEY = "ani-pang-versus-sessions";

export interface VersusOpponent {
  id: string;
  nickname: string;
  animal: CharacterId;
  rp: number;
  scoreTarget: number;
  isBot: boolean;
}

export interface VersusQueueResult {
  match: MatchStartResult;
  opponent: VersusOpponent;
  startsAtMs: number;
}

export type VersusOutcome = "win" | "lose";

export interface VersusFinishResult {
  result: VersusOutcome;
  rpDelta: number;
  rewards: {
    stars: number;
  };
  playerScore: number;
  opponentScore: number;
  opponent: VersusOpponent;
  profile: PlayerProfile;
}

interface StoredVersusSession {
  matchId: string;
  opponent: VersusOpponent;
  startedAtMs: number;
  startsAtMs: number;
}

const localBots: VersusOpponent[] = [
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

async function callVersusFunction<Input, Output>(name: string, data: Input) {
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

function readLocalSessions(): StoredVersusSession[] {
  try {
    const raw = localStorage.getItem(LOCAL_VERSUS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredVersusSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalSession(session: StoredVersusSession) {
  const previous = readLocalSessions().filter((item) => item.matchId !== session.matchId);
  localStorage.setItem(LOCAL_VERSUS_KEY, JSON.stringify([...previous, session].slice(-20)));
}

function removeLocalSession(matchId: string) {
  localStorage.setItem(
    LOCAL_VERSUS_KEY,
    JSON.stringify(readLocalSessions().filter((item) => item.matchId !== matchId)),
  );
}

function clampInt(value: unknown, fallback = 0, min = 0, max = 99999999) {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function tierFromRp(rp: number): PlayerTier {
  if (rp >= 2600) return "DIAMOND";
  if (rp >= 2100) return "PLATINUM";
  if (rp >= 1600) return "GOLD";
  if (rp >= 1200) return "SILVER";
  return "BRONZE";
}

function randomId(prefix: string) {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function localOpponentFor(profile: PlayerProfile): VersusOpponent {
  const sorted = [...localBots].sort(
    (a, b) => Math.abs(a.rp - profile.rp) - Math.abs(b.rp - profile.rp),
  );
  const bot = sorted[Math.floor(Math.random() * Math.min(3, sorted.length))] || sorted[0];
  const variance = Math.round((Math.random() - 0.42) * 3600);
  const scoreTarget = clampInt(
    Math.max(bot.scoreTarget, profile.bestScore * 0.84) + variance,
    bot.scoreTarget,
    3000,
    9999999,
  );
  return { ...bot, scoreTarget };
}

export async function queueVersus(profile: PlayerProfile): Promise<VersusQueueResult> {
  if (profile.authMode === "firebase") {
    const result = await callVersusFunction<Record<string, never>, VersusQueueResult>(
      "queueVersus",
      {},
    );
    if (result) return result;
  }

  const matchId = randomId("local-versus");
  const startedAtMs = Date.now();
  const opponent = localOpponentFor(profile);
  const session: StoredVersusSession = {
    matchId,
    opponent,
    startedAtMs,
    startsAtMs: startedAtMs + 800,
  };
  writeLocalSession(session);

  return {
    match: {
      matchId,
      mode: "versus",
      seed: createMatchSeed(matchId),
      startedAtMs,
      savedOnline: false,
    },
    opponent,
    startsAtMs: session.startsAtMs,
  };
}

export async function finishVersus(
  profile: PlayerProfile,
  matchId: string,
  playerScore: number,
): Promise<VersusFinishResult> {
  if (profile.authMode === "firebase") {
    const result = await callVersusFunction<{ matchId: string }, VersusFinishResult>(
      "finishVersus",
      { matchId },
    );
    if (result) return result;
  }

  const session = readLocalSessions().find((item) => item.matchId === matchId);
  if (!session) throw new Error("대전 세션을 찾지 못했어요.");

  const score = clampInt(playerScore, 0, 0, 9999999);
  const opponentScore = clampInt(session.opponent.scoreTarget, 0, 0, 9999999);
  const result: VersusOutcome = score >= opponentScore ? "win" : "lose";
  const rpDelta = result === "win" ? 24 : -14;
  const stars = result === "win" ? 12 : 3;
  const rp = clampInt(profile.rp + rpDelta, profile.rp, 0, 999999);
  const nextProfile: PlayerProfile = {
    ...profile,
    rp,
    tier: tierFromRp(rp),
    stars: profile.stars + stars,
  };
  await persistPlayerProfile(nextProfile);
  removeLocalSession(matchId);

  return {
    result,
    rpDelta,
    rewards: { stars },
    playerScore: score,
    opponentScore,
    opponent: session.opponent,
    profile: nextProfile,
  };
}
