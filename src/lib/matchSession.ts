import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";

const LOCAL_MATCHES_KEY = "ani-pang-match-sessions";
const VERSION = "0.2.0";
let firebaseUnavailable = false;

export type MatchMode = "rush" | "stage" | "versus";

export interface MatchStartResult {
  matchId: string;
  mode: MatchMode;
  seed: string;
  startedAtMs: number;
  savedOnline: boolean;
}

export interface ReplayMove {
  r: number;
  c: number;
  dir: "up" | "down" | "left" | "right";
  t: number;
}

export interface MatchFinishInput {
  matchId: string;
  playerUid?: string;
  mode: MatchMode;
  seed: string;
  startedAtMs: number;
  score: number;
  maxCombo: number;
  matchedCells: number;
  specialTriggers: number;
  feverCount: number;
  rewards: {
    xp: number;
    stars: number;
  };
  replay?: ReplayMove[];
}

export interface MatchFinishResult {
  accepted: boolean;
  savedOnline: boolean;
}

interface StoredMatch extends MatchFinishInput {
  status: "started" | "finished";
  finishedAtMs?: number;
  accepted?: boolean;
}

async function callMatchFunction<Input, Output>(name: string, data: Input) {
  if (!isFirebaseConfigured || !useFirebaseFunctions || firebaseUnavailable) return null;
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

function readLocalMatches(): StoredMatch[] {
  try {
    const raw = localStorage.getItem(LOCAL_MATCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredMatch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalMatch(match: StoredMatch) {
  const previous = readLocalMatches().filter((entry) => entry.matchId !== match.matchId);
  localStorage.setItem(LOCAL_MATCHES_KEY, JSON.stringify([...previous, match].slice(-50)));
}

function clampInt(value: number, min = 0, max = 99999999) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function firebaseErrorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function isVerificationError(error: unknown) {
  const code = firebaseErrorCode(error);
  return (
    code.includes("invalid-argument") ||
    code.includes("permission-denied") ||
    code.includes("failed-precondition") ||
    code.includes("already-exists")
  );
}

function normalizeReplay(replay: ReplayMove[] | undefined) {
  return (replay || []).slice(0, 240).map((move) => ({
    r: clampInt(move.r, 0, 6),
    c: clampInt(move.c, 0, 6),
    dir: move.dir,
    t: clampInt(move.t, 0, 180000),
  }));
}

export function createMatchSeed(matchId: string) {
  return `${matchId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export function createSeededRandom(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function startMatch(input: {
  matchId: string;
  playerUid?: string;
  mode: MatchMode;
}): Promise<MatchStartResult> {
  const seed = createMatchSeed(input.matchId);
  const startedAtMs = Date.now();
  writeLocalMatch({
    matchId: input.matchId,
    playerUid: input.playerUid,
    mode: input.mode,
    seed,
    startedAtMs,
    status: "started",
    score: 0,
    maxCombo: 0,
    matchedCells: 0,
    specialTriggers: 0,
    feverCount: 0,
    rewards: { xp: 0, stars: 0 },
  });

  const savedOnline = false;
  try {
    const result = await callMatchFunction<{ matchId: string; mode: MatchMode }, MatchStartResult>(
      "startMatchSession",
      { matchId: input.matchId, mode: input.mode },
    );
    if (result) {
      writeLocalMatch({
        matchId: result.matchId,
        playerUid: input.playerUid,
        mode: result.mode,
        seed: result.seed,
        startedAtMs: result.startedAtMs,
        status: "started",
        score: 0,
        maxCombo: 0,
        matchedCells: 0,
        specialTriggers: 0,
        feverCount: 0,
        rewards: { xp: 0, stars: 0 },
      });
      return result;
    }
  } catch (error) {
    if (isVerificationError(error)) throw error;
    firebaseUnavailable = true;
  }

  return { matchId: input.matchId, mode: input.mode, seed, startedAtMs, savedOnline };
}

export async function finishMatch(input: MatchFinishInput): Promise<MatchFinishResult> {
  const accepted = input.score > 0;
  const finishedAtMs = Date.now();
  const replay = normalizeReplay(input.replay);
  const finished: StoredMatch = {
    ...input,
    score: clampInt(input.score),
    maxCombo: clampInt(input.maxCombo, 0, 999),
    matchedCells: clampInt(input.matchedCells),
    specialTriggers: clampInt(input.specialTriggers, 0, 99999),
    feverCount: clampInt(input.feverCount, 0, 999),
    rewards: {
      xp: clampInt(input.rewards.xp),
      stars: clampInt(input.rewards.stars),
    },
    replay,
    status: "finished",
    finishedAtMs,
    accepted,
  };
  writeLocalMatch(finished);

  const savedOnline = false;
  try {
    const result = await callMatchFunction<MatchFinishInput, MatchFinishResult>(
      "finishMatchSession",
      {
        ...input,
        score: finished.score,
        maxCombo: finished.maxCombo,
        matchedCells: finished.matchedCells,
        specialTriggers: finished.specialTriggers,
        feverCount: finished.feverCount,
        rewards: finished.rewards,
        replay,
      },
    );
    if (result) {
      return result;
    }
  } catch (error) {
    if (isVerificationError(error)) throw error;
    firebaseUnavailable = true;
  }

  return { accepted, savedOnline };
}
