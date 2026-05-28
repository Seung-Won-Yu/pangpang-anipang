import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";

const LOCAL_KEY = "ani-pang-leaderboard";
const VERSION = "0.1.0";
const MAX_LOCAL_SCORES = 100;
const MAX_VISIBLE_SCORES = 20;
let firebaseUnavailable = false;

export type LeaderboardScope = "today" | "weekly" | "all";
export type LeaderboardAudience = "global" | "friends";

export interface LeaderboardEntry {
  id?: string;
  playerUid?: string;
  nickname: string;
  score: number;
  maxCombo: number;
  feverCount: number;
  mode: "60s";
  version: string;
  playedAtDay: string;
  playedAtWeek: string;
}

export interface ScorePayload {
  runId: string;
  playerUid?: string;
  nickname: string;
  score: number;
  maxCombo: number;
  feverCount: number;
}

export interface SavedScoreResult extends LeaderboardEntry {
  savedOnline: boolean;
}

async function getFirebaseLeaderboardApi() {
  if (!isFirebaseConfigured || firebaseUnavailable) return null;
  const [firestore, firebase] = await Promise.all([
    import("firebase/firestore"),
    import("./firebase"),
  ]);
  if (!firebase.db) return null;
  return { ...firestore, auth: firebase.auth, db: firebase.db };
}

async function callLeaderboardFunction<Input, Output>(name: string, data: Input) {
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

export function sanitizeNickname(nickname: string) {
  const clean = nickname.replace(/\s+/g, " ").trim().slice(0, 12);
  return clean || "게스트";
}

export function getTodayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getWeekKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localDate = new Date(`${values.year}-${values.month}-${values.day}T00:00:00+09:00`);
  const day = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(localDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((localDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${localDate.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function normalizeEntry(data: Partial<LeaderboardEntry>, id?: string): LeaderboardEntry {
  return {
    id,
    playerUid: data.playerUid,
    nickname: sanitizeNickname(data.nickname || ""),
    score: Number(data.score) || 0,
    maxCombo: Number(data.maxCombo) || 0,
    feverCount: Number(data.feverCount) || 0,
    mode: "60s",
    version: data.version || VERSION,
    playedAtDay: data.playedAtDay || getTodayKey(),
    playedAtWeek: data.playedAtWeek || getWeekKey(),
  };
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

function topScores(scores: LeaderboardEntry[], count = MAX_VISIBLE_SCORES) {
  return [...scores].sort((a, b) => b.score - a.score).slice(0, count);
}

function readLocalScores(): LeaderboardEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<LeaderboardEntry>[];
    return Array.isArray(parsed) ? parsed.map((entry) => normalizeEntry(entry)) : [];
  } catch {
    return [];
  }
}

function writeLocalScore(entry: LeaderboardEntry) {
  const previous = readLocalScores().filter((score) => !entry.id || score.id !== entry.id);
  const next = topScores([...previous, entry], MAX_LOCAL_SCORES);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
}

function localLeaderboard(scope: LeaderboardScope) {
  const scores = readLocalScores();
  const day = getTodayKey();
  const week = getWeekKey();
  return topScores(
    scope === "today"
      ? scores.filter((entry) => entry.playedAtDay === day)
      : scope === "weekly"
        ? scores.filter((entry) => entry.playedAtWeek === week)
        : scores,
  );
}

export async function fetchLeaderboard(
  scope: LeaderboardScope = "all",
  audience: LeaderboardAudience = "global",
): Promise<LeaderboardEntry[]> {
  try {
    const result = await callLeaderboardFunction<
      { range: LeaderboardScope; scope: LeaderboardAudience; limit: number },
      {
        list: Partial<LeaderboardEntry>[];
      }
    >("getLeaderboard", { range: scope, scope: audience, limit: MAX_VISIBLE_SCORES });
    if (result) {
      return topScores(result.list.map((entry) => normalizeEntry(entry, entry.id)));
    }
  } catch (error) {
    if (audience === "friends") {
      firebaseUnavailable = true;
      return localLeaderboard(scope);
    }
    if (isVerificationError(error)) throw error;
  }

  try {
    if (audience === "friends") return localLeaderboard(scope);
    const api = await getFirebaseLeaderboardApi();
    if (!api) return localLeaderboard(scope);
    const { collection, getDocs, limit, orderBy, query, where, db } = api;
    const scoresRef = collection(db, "scores");
    const snapshot =
      scope === "today"
        ? await getDocs(query(scoresRef, where("playedAtDay", "==", getTodayKey()), limit(100)))
        : scope === "weekly"
          ? await getDocs(query(scoresRef, where("playedAtWeek", "==", getWeekKey()), limit(100)))
          : await getDocs(query(scoresRef, orderBy("score", "desc"), limit(MAX_VISIBLE_SCORES)));
    return topScores(
      snapshot.docs.map((doc) => normalizeEntry(doc.data() as Partial<LeaderboardEntry>, doc.id)),
    );
  } catch {
    firebaseUnavailable = true;
    return localLeaderboard(scope);
  }
}

export async function saveScore(payload: ScorePayload): Promise<SavedScoreResult> {
  const entry: LeaderboardEntry = {
    id: payload.runId,
    playerUid: payload.playerUid || "guest",
    nickname: sanitizeNickname(payload.nickname),
    score: Math.max(0, Math.round(payload.score)),
    maxCombo: Math.max(0, Math.round(payload.maxCombo)),
    feverCount: Math.max(0, Math.round(payload.feverCount)),
    mode: "60s",
    version: VERSION,
    playedAtDay: getTodayKey(),
    playedAtWeek: getWeekKey(),
  };

  try {
    const result = await callLeaderboardFunction<
      { runId: string; nickname: string },
      SavedScoreResult
    >("submitLeaderboardScore", { runId: payload.runId, nickname: entry.nickname });
    if (result) {
      const savedEntry = { ...normalizeEntry(result, result.id), savedOnline: true };
      writeLocalScore(savedEntry);
      return savedEntry;
    }
  } catch (error) {
    if (isVerificationError(error)) throw error;
    firebaseUnavailable = true;
    // Network or callable availability failures degrade to the local leaderboard.
  }

  try {
    const api = await getFirebaseLeaderboardApi();
    const user = api?.auth?.currentUser;
    if (api && user) {
      const { db, doc, setDoc } = api;
      const onlineEntry = { ...entry, playerUid: user.uid };
      const { id: _id, ...scoreData } = onlineEntry;
      await setDoc(doc(db, "scores", payload.runId), scoreData);
      writeLocalScore(onlineEntry);
      return { ...onlineEntry, savedOnline: true };
    }
  } catch {
    firebaseUnavailable = true;
  }

  writeLocalScore(entry);
  return { ...entry, savedOnline: false };
}
