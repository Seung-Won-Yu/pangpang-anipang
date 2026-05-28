import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";
import { sanitizeNickname } from "./leaderboard";

const LOCAL_PLAYER_KEY = "ani-pang-player-profile";
const LOCAL_UID_KEY = "ani-pang-player-uid";

export const MAX_HEARTS = 5;
export const HEART_REGEN_MS = 20 * 60 * 1000;
let firebaseUnavailable = false;

export type CharacterId = "puppy" | "cat" | "rabbit" | "bear" | "panda" | "chick";
export type CosmeticId = "spring-coat" | "gold-board";
export type PlayerTier = "BRONZE" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND";
export type AuthProviderId = "anonymous" | "google.com" | "apple.com" | "oidc.kakao";
export type AccountProviderKey = "google" | "apple" | "kakao";

export interface PlayerInventory {
  hint: number;
  hammer: number;
  shuffle: number;
  timePlus: number;
}

export interface PlayerProgressState {
  level: number;
  xp: number;
  stars: number;
  streak: number;
  lastDailyKey: string;
  completedDailyKeys: string[];
}

export interface RunProgressPatch {
  matchId?: string;
  score: number;
  matchedCells: number;
  maxCombo: number;
  specialTriggers: number;
  feverCount: number;
}

export interface PlayerProfile {
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
  tier: PlayerTier;
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
  authMode: "firebase" | "local";
}

export interface PlayerStats {
  uid: string;
  nickname: string;
  tier: PlayerTier;
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

export type PlayerDataExport = Record<string, unknown>;

const defaultInventory = (): PlayerInventory => ({
  hint: 2,
  hammer: 0,
  shuffle: 1,
  timePlus: 1,
});

const characterIds: CharacterId[] = ["puppy", "cat", "rabbit", "bear", "panda", "chick"];
const cosmeticIds: CosmeticId[] = ["spring-coat", "gold-board"];
const authProviderIds: AuthProviderId[] = ["anonymous", "google.com", "apple.com", "oidc.kakao"];

function clampInt(value: unknown, fallback = 0, min = 0, max = 9999999) {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function normalizeCharacter(value: unknown, fallback: CharacterId = "puppy"): CharacterId {
  return typeof value === "string" && characterIds.includes(value as CharacterId)
    ? (value as CharacterId)
    : fallback;
}

function normalizeTier(value: unknown): PlayerTier {
  return value === "SILVER" || value === "GOLD" || value === "PLATINUM" || value === "DIAMOND"
    ? value
    : "BRONZE";
}

function normalizeAuthProvider(value: unknown): AuthProviderId {
  return typeof value === "string" && authProviderIds.includes(value as AuthProviderId)
    ? (value as AuthProviderId)
    : "anonymous";
}

function normalizeLinkedProviders(value: unknown): AuthProviderId[] {
  if (!Array.isArray(value)) return ["anonymous"];
  const providers = value
    .map(normalizeAuthProvider)
    .filter((item, index, list) => list.indexOf(item) === index);
  return providers.length ? providers : ["anonymous"];
}

function normalizeCharacterList(value: unknown): CharacterId[] {
  if (!Array.isArray(value)) return ["puppy"];
  const unlocked = value
    .map((item) => normalizeCharacter(item, "puppy"))
    .filter((item, index, list) => list.indexOf(item) === index);
  return unlocked.length ? unlocked : ["puppy"];
}

function normalizeCosmetics(value: unknown): CosmeticId[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is CosmeticId =>
        typeof item === "string" && cosmeticIds.includes(item as CosmeticId),
    )
    .filter((item, index, list) => list.indexOf(item) === index);
}

function normalizeCharacterNumberMap(value: unknown, fallback = 0, max = 999999) {
  const source = (value || {}) as Partial<Record<CharacterId, unknown>>;
  return characterIds.reduce<Partial<Record<CharacterId, number>>>((result, character) => {
    result[character] = clampInt(source[character], fallback, 0, max);
    return result;
  }, {});
}

async function getFirebasePlayerApi() {
  if (!isFirebaseConfigured || firebaseUnavailable) return null;
  const [authApi, firestoreApi, firebase] = await Promise.all([
    import("firebase/auth"),
    import("firebase/firestore"),
    import("./firebase"),
  ]);
  if (!firebase.auth || !firebase.db) return null;
  return { ...authApi, ...firestoreApi, auth: firebase.auth, db: firebase.db };
}

async function callPlayerFunction<Input, Output>(name: string, data: Input) {
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

function createLocalUid() {
  const existing = localStorage.getItem(LOCAL_UID_KEY);
  if (existing) return existing;
  const uid = `local-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  localStorage.setItem(LOCAL_UID_KEY, uid);
  return uid;
}

function defaultProfile(uid: string, nickname: string, authMode: PlayerProfile["authMode"]) {
  return recoverHearts({
    uid,
    nickname: sanitizeNickname(nickname),
    hearts: MAX_HEARTS,
    coins: 0,
    bestScore: 0,
    totalScore: 0,
    lastHeartAt: Date.now(),
    inventory: defaultInventory(),
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
    authMode,
  });
}

function normalizeProfile(
  uid: string,
  data: Partial<PlayerProfile>,
  nickname: string,
  authMode: PlayerProfile["authMode"],
) {
  const inventory = (data.inventory || {}) as Partial<PlayerInventory>;
  const level = clampInt(data.level, 1, 1, 999);
  const xp = clampInt(data.xp, 0);
  const completedDailyKeys = Array.isArray(data.completedDailyKeys)
    ? data.completedDailyKeys.filter((key): key is string => typeof key === "string").slice(-31)
    : [];

  return recoverHearts({
    uid,
    nickname: sanitizeNickname(data.nickname || nickname),
    hearts: clampInt(data.hearts, MAX_HEARTS, 0, MAX_HEARTS),
    coins: clampInt(data.coins, 0),
    bestScore: clampInt(data.bestScore, 0),
    totalScore: clampInt(data.totalScore, 0, 0, 999999999),
    lastHeartAt: clampInt(data.lastHeartAt, Date.now()),
    inventory: {
      ...defaultInventory(),
      hint: clampInt(inventory.hint, defaultInventory().hint, 0, 999),
      hammer: clampInt(inventory.hammer, defaultInventory().hammer, 0, 999),
      shuffle: clampInt(inventory.shuffle, defaultInventory().shuffle, 0, 999),
      timePlus: clampInt(inventory.timePlus, defaultInventory().timePlus, 0, 999),
    },
    level,
    xp,
    stars: clampInt(data.stars, 0),
    streak: clampInt(data.streak, 0, 0, 9999),
    lastDailyKey: typeof data.lastDailyKey === "string" ? data.lastDailyKey.slice(0, 10) : "",
    completedDailyKeys,
    rp: clampInt(data.rp, 1000, 0, 999999),
    tier: normalizeTier(data.tier),
    mainCharacter: normalizeCharacter(data.mainCharacter),
    unlockedCharacters: normalizeCharacterList(data.unlockedCharacters),
    characterLevels: normalizeCharacterNumberMap(data.characterLevels, 0, 99),
    characterAffinity: normalizeCharacterNumberMap(data.characterAffinity),
    characterPlays: normalizeCharacterNumberMap(data.characterPlays),
    cosmetics: normalizeCosmetics(data.cosmetics),
    totalPlays: clampInt(data.totalPlays, 0),
    totalMatches: clampInt(data.totalMatches, 0),
    maxCombo: clampInt(data.maxCombo, 0, 0, 999),
    totalSpecials: clampInt(data.totalSpecials, 0),
    authProvider: normalizeAuthProvider(data.authProvider),
    linkedProviders: normalizeLinkedProviders(data.linkedProviders),
    seasonPassPremium: data.seasonPassPremium === true,
    vipUntil: clampInt(data.vipUntil, 0, 0, 4102444800000),
    authMode,
  });
}

function firebaseErrorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function createAccountProvider(
  api: NonNullable<Awaited<ReturnType<typeof getFirebasePlayerApi>>>,
  provider: AccountProviderKey,
) {
  if (provider === "google") {
    const googleProvider = new api.GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: "select_account" });
    return { providerId: "google.com" as const, authProvider: googleProvider };
  }

  if (provider === "apple") {
    const appleProvider = new api.OAuthProvider("apple.com");
    appleProvider.addScope("email");
    appleProvider.addScope("name");
    return { providerId: "apple.com" as const, authProvider: appleProvider };
  }

  const kakaoProvider = new api.OAuthProvider("oidc.kakao");
  return { providerId: "oidc.kakao" as const, authProvider: kakaoProvider };
}

export function recoverHearts(profile: PlayerProfile, now = Date.now()): PlayerProfile {
  if (profile.hearts >= MAX_HEARTS) {
    return { ...profile, hearts: MAX_HEARTS, lastHeartAt: now };
  }

  const elapsed = Math.max(0, now - profile.lastHeartAt);
  const gained = Math.floor(elapsed / HEART_REGEN_MS);
  if (gained <= 0) return profile;

  const hearts = Math.min(MAX_HEARTS, profile.hearts + gained);
  return {
    ...profile,
    hearts,
    lastHeartAt: hearts >= MAX_HEARTS ? now : profile.lastHeartAt + gained * HEART_REGEN_MS,
  };
}

export function getNextHeartAt(profile: PlayerProfile) {
  if (profile.hearts >= MAX_HEARTS) return null;
  return profile.lastHeartAt + HEART_REGEN_MS;
}

export function buildPlayerStats(profile: PlayerProfile): PlayerStats {
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

function readLocalProfile(nickname: string) {
  const uid = createLocalUid();
  try {
    const raw = localStorage.getItem(LOCAL_PLAYER_KEY);
    if (!raw) return defaultProfile(uid, nickname, "local");
    return normalizeProfile(uid, JSON.parse(raw) as Partial<PlayerProfile>, nickname, "local");
  } catch {
    return defaultProfile(uid, nickname, "local");
  }
}

async function persistLocalProfile(profile: PlayerProfile) {
  localStorage.setItem(LOCAL_PLAYER_KEY, JSON.stringify(profile));
}

function firestoreProfileData(profile: PlayerProfile) {
  return {
    nickname: sanitizeNickname(profile.nickname),
    hearts: clampInt(profile.hearts, MAX_HEARTS, 0, MAX_HEARTS),
    coins: clampInt(profile.coins, 0),
    bestScore: clampInt(profile.bestScore, 0),
    totalScore: clampInt(profile.totalScore, 0, 0, 999999999),
    lastHeartAt: clampInt(profile.lastHeartAt, Date.now()),
    inventory: {
      hint: clampInt(profile.inventory.hint, defaultInventory().hint, 0, 999),
      hammer: clampInt(profile.inventory.hammer, defaultInventory().hammer, 0, 999),
      shuffle: clampInt(profile.inventory.shuffle, defaultInventory().shuffle, 0, 999),
      timePlus: clampInt(profile.inventory.timePlus, defaultInventory().timePlus, 0, 999),
    },
    level: clampInt(profile.level, 1, 1, 999),
    xp: clampInt(profile.xp, 0, 0, 99999999),
    stars: clampInt(profile.stars, 0, 0, 99999999),
    streak: clampInt(profile.streak, 0, 0, 9999),
    lastDailyKey: profile.lastDailyKey.slice(0, 10),
    completedDailyKeys: profile.completedDailyKeys
      .filter((key): key is string => typeof key === "string")
      .slice(-31),
    rp: clampInt(profile.rp, 1000, 0, 999999),
    tier: normalizeTier(profile.tier),
    mainCharacter: normalizeCharacter(profile.mainCharacter),
    unlockedCharacters: normalizeCharacterList(profile.unlockedCharacters),
    characterLevels: normalizeCharacterNumberMap(profile.characterLevels, 0, 99),
    characterAffinity: normalizeCharacterNumberMap(profile.characterAffinity),
    characterPlays: normalizeCharacterNumberMap(profile.characterPlays),
    cosmetics: normalizeCosmetics(profile.cosmetics),
    totalPlays: clampInt(profile.totalPlays, 0, 0, 99999999),
    totalMatches: clampInt(profile.totalMatches, 0, 0, 99999999),
    maxCombo: clampInt(profile.maxCombo, 0, 0, 999),
    totalSpecials: clampInt(profile.totalSpecials, 0, 0, 99999999),
    authProvider: normalizeAuthProvider(profile.authProvider),
    linkedProviders: normalizeLinkedProviders(profile.linkedProviders),
    seasonPassPremium: profile.seasonPassPremium === true,
    vipUntil: clampInt(profile.vipUntil, 0, 0, 4102444800000),
  };
}

async function persistFirebaseProfile(profile: PlayerProfile) {
  const api = await getFirebasePlayerApi();
  const user = api?.auth.currentUser;
  if (!api || !user || user.uid !== profile.uid) {
    throw new Error("Firebase 플레이어 세션을 다시 준비해주세요.");
  }

  const readyProfile = recoverHearts(profile);
  const { db, doc, serverTimestamp, setDoc } = api;
  await setDoc(
    doc(db, "users", profile.uid),
    {
      ...firestoreProfileData(readyProfile),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function persistPlayerProfile(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    await persistFirebaseProfile(profile);
    return;
  }
  await persistLocalProfile(profile);
}

export async function ensurePlayer(nickname: string): Promise<PlayerProfile> {
  const cleanName = sanitizeNickname(nickname);

  const api = await getFirebasePlayerApi();
  if (!api) {
    const profile = readLocalProfile(cleanName);
    await persistLocalProfile(profile);
    return profile;
  }

  try {
    const { auth, db, doc, getDoc, serverTimestamp, setDoc, signInAnonymously } = api;
    const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
    const result = await callPlayerFunction<
      { nickname: string },
      { profile: Partial<PlayerProfile> }
    >("ensurePlayerProfile", { nickname: cleanName });
    if (result) return normalizeProfile(user.uid, result.profile, cleanName, "firebase");

    const profileRef = doc(db, "users", user.uid);
    const snapshot = await getDoc(profileRef);
    const profile = snapshot.exists()
      ? normalizeProfile(user.uid, snapshot.data() as Partial<PlayerProfile>, cleanName, "firebase")
      : defaultProfile(user.uid, cleanName, "firebase");
    const readyProfile = recoverHearts(profile);

    await setDoc(
      profileRef,
      {
        ...firestoreProfileData(readyProfile),
        ...(snapshot.exists() ? {} : { createdAt: serverTimestamp() }),
        lastLoginAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    return readyProfile;
  } catch {
    firebaseUnavailable = true;
    const profile = readLocalProfile(cleanName);
    await persistLocalProfile(profile);
    return profile;
  }
}

export async function savePlayerNickname(profile: PlayerProfile, nickname: string) {
  const nextProfile = { ...profile, nickname: sanitizeNickname(nickname) };
  if (profile.authMode === "firebase") {
    await persistPlayerProfile(nextProfile);
    return nextProfile;
  }

  await persistPlayerProfile(nextProfile);
  return nextProfile;
}

export async function linkPlayerAccount(profile: PlayerProfile, provider: AccountProviderKey) {
  if (profile.authMode !== "firebase") {
    throw new Error("Firebase 계정에서만 소셜 연동을 사용할 수 있어요.");
  }

  const api = await getFirebasePlayerApi();
  const user = api?.auth.currentUser;
  if (!api || !user) {
    throw new Error("계정 세션을 다시 준비한 뒤 시도해주세요.");
  }

  const { providerId, authProvider } = createAccountProvider(api, provider);
  const alreadyLinked = user.providerData.some((item) => item.providerId === providerId);

  if (!alreadyLinked) {
    try {
      await api.linkWithPopup(user, authProvider);
    } catch (error) {
      const code = firebaseErrorCode(error);
      if (code === "auth/provider-already-linked") {
        // The provider is already attached to this Firebase user; sync below.
      } else if (
        code === "auth/credential-already-in-use" ||
        code === "auth/email-already-in-use"
      ) {
        throw new Error("이미 다른 계정에 연결된 소셜 계정이에요.");
      } else if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        throw new Error("계정 연동이 취소됐어요.");
      } else {
        throw new Error("계정 연동에 실패했어요. Firebase provider 설정을 확인해주세요.");
      }
    }
  }

  const result = await callPlayerFunction<
    { nickname: string },
    { profile: Partial<PlayerProfile> }
  >("syncAccountProviders", { nickname: profile.nickname });
  if (!result) throw new Error("계정 연동 상태를 저장하지 못했어요.");
  return normalizeProfile(user.uid, result.profile, profile.nickname, "firebase");
}

export async function getPlayerStats(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    const result = await callPlayerFunction<
      Record<string, never>,
      { profile: Partial<PlayerProfile>; stats: PlayerStats }
    >("getPlayerStats", {});
    if (result) {
      const nextProfile = normalizeProfile(
        profile.uid,
        result.profile,
        profile.nickname,
        "firebase",
      );
      return { profile: nextProfile, stats: result.stats || buildPlayerStats(nextProfile) };
    }
  }

  const readyProfile = recoverHearts(profile);
  return { profile: readyProfile, stats: buildPlayerStats(readyProfile) };
}

export async function createRestoreCode(profile: PlayerProfile) {
  if (profile.authMode !== "firebase") {
    throw new Error("Firebase 계정에서만 복원 코드를 만들 수 있어요.");
  }
  const result = await callPlayerFunction<
    Record<string, never>,
    { code: string; expiresAtMs: number }
  >("createRestoreCode", {});
  if (!result) throw new Error("복원 코드를 만들지 못했어요.");
  return result;
}

export async function restorePlayerProfile(profile: PlayerProfile, code: string) {
  if (profile.authMode !== "firebase") {
    throw new Error("Firebase 계정에서만 복원을 사용할 수 있어요.");
  }
  const result = await callPlayerFunction<{ code: string }, { profile: Partial<PlayerProfile> }>(
    "restorePlayerProfile",
    { code },
  );
  if (!result) throw new Error("프로필 복원에 실패했어요.");
  return normalizeProfile(profile.uid, result.profile, profile.nickname, "firebase");
}

export async function deletePlayerAccount(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    const result = await callPlayerFunction<Record<string, never>, { deleted: boolean }>(
      "deletePlayerAccount",
      {},
    );
    if (!result?.deleted) throw new Error("계정 삭제에 실패했어요.");
    const [authApi, firebase] = await Promise.all([import("firebase/auth"), import("./firebase")]);
    if (firebase.auth) await authApi.signOut(firebase.auth);
    return true;
  }

  localStorage.removeItem(LOCAL_PLAYER_KEY);
  localStorage.removeItem(LOCAL_UID_KEY);
  return true;
}

export async function exportPlayerData(profile: PlayerProfile): Promise<PlayerDataExport> {
  if (profile.authMode === "firebase") {
    const result = await callPlayerFunction<Record<string, never>, PlayerDataExport>(
      "exportPlayerData",
      {},
    );
    if (!result) throw new Error("계정 데이터를 내보내지 못했어요.");
    return result;
  }

  return {
    exportedAt: new Date().toISOString(),
    uid: profile.uid,
    profile,
    stats: buildPlayerStats(profile),
    storage: "local",
  };
}

export async function spendHeart(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    const result = await callPlayerFunction<
      Record<string, never>,
      { spent: boolean; profile: PlayerProfile }
    >("spendHeart", {});
    if (result) return result;
  }

  const readyProfile = recoverHearts(profile);
  if (readyProfile.hearts <= 0) {
    await persistPlayerProfile(readyProfile);
    return { spent: false, profile: readyProfile };
  }

  const nextProfile = {
    ...readyProfile,
    hearts: readyProfile.hearts - 1,
    lastHeartAt: readyProfile.hearts >= MAX_HEARTS ? Date.now() : readyProfile.lastHeartAt,
  };
  await persistPlayerProfile(nextProfile);
  return { spent: true, profile: nextProfile };
}

export async function claimHeartTimer(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    const result = await callPlayerFunction<
      Record<string, never>,
      { claimed: number; nextHeartAt: number | null; profile: PlayerProfile }
    >("claimHeartTimer", {});
    if (result) return result;
  }

  const readyProfile = recoverHearts(profile);
  const claimed = Math.max(0, readyProfile.hearts - profile.hearts);
  if (claimed > 0 || readyProfile.lastHeartAt !== profile.lastHeartAt) {
    await persistPlayerProfile(readyProfile);
  }
  return {
    claimed,
    nextHeartAt: getNextHeartAt(readyProfile),
    profile: readyProfile,
  };
}

export async function refundHeart(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    const result = await callPlayerFunction<Record<string, never>, { profile: PlayerProfile }>(
      "refundHeart",
      {},
    );
    if (result) return result.profile;
  }

  const readyProfile = recoverHearts(profile);
  const hearts = Math.min(MAX_HEARTS, readyProfile.hearts + 1);
  const nextProfile = {
    ...readyProfile,
    hearts,
    lastHeartAt: hearts >= MAX_HEARTS ? Date.now() : readyProfile.lastHeartAt,
  };
  await persistPlayerProfile(nextProfile);
  return nextProfile;
}

export async function updateBestScore(profile: PlayerProfile, score: number) {
  const nextBest = Math.max(profile.bestScore, Math.round(score));
  if (nextBest === profile.bestScore) return profile;

  const nextProfile = { ...profile, bestScore: nextBest };
  await persistPlayerProfile(nextProfile);
  return nextProfile;
}

export async function recordRunProgress(
  profile: PlayerProfile,
  progress: PlayerProgressState,
  run: RunProgressPatch,
) {
  if (profile.authMode === "firebase") {
    const result = await callPlayerFunction<
      { progress: PlayerProgressState; run: RunProgressPatch },
      { profile: PlayerProfile }
    >("recordRunProgress", { progress, run });
    if (result) return result.profile;
  }

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
    bestScore: Math.max(profile.bestScore, Math.round(run.score)),
    totalScore: profile.totalScore + Math.max(0, Math.round(run.score)),
    totalPlays: profile.totalPlays + 1,
    totalMatches: profile.totalMatches + Math.max(0, Math.round(run.matchedCells)),
    maxCombo: Math.max(profile.maxCombo, Math.max(0, Math.round(run.maxCombo))),
    totalSpecials: profile.totalSpecials + Math.max(0, Math.round(run.specialTriggers)),
    characterAffinity,
    characterPlays,
  };
  await persistPlayerProfile(nextProfile);
  return nextProfile;
}
