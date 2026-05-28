import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";
import type { CharacterId, PlayerProfile } from "./player";

const LOCAL_GUILDS_KEY = "ani-pang-guilds";
const LOCAL_USER_GUILD_PREFIX = "ani-pang-user-guild";

export interface GuildBossState {
  weekId: string;
  hp: number;
  hpMax: number;
}

export interface GuildSummary {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  level: number;
  memberCount: number;
  weeklyScore: number;
  rank: number;
  boss: GuildBossState;
}

export interface GuildMember {
  id: string;
  nickname: string;
  animal: CharacterId;
  role: "leader" | "member";
  weeklyContribution: number;
  joinedAt: string | null;
}

export interface GuildState {
  guild: GuildSummary | null;
  boss: GuildBossState | null;
  members: GuildMember[];
}

async function callGuildFunction<Input, Output>(name: string, data: Input) {
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

function userGuildKey(uid: string) {
  return `${LOCAL_USER_GUILD_PREFIX}:${uid}`;
}

function currentWeekKey() {
  const now = new Date();
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((now.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${now.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function defaultBoss(level = 1): GuildBossState {
  const hpMax = 500000 + Math.max(0, level - 1) * 50000;
  return { weekId: currentWeekKey(), hp: hpMax, hpMax };
}

function sanitizeGuildName(value: string) {
  return value.trim().slice(0, 16);
}

function sanitizeGuildDescription(value: string) {
  return value.trim().slice(0, 80);
}

function readLocalGuilds(): Record<string, GuildState> {
  try {
    const raw = localStorage.getItem(LOCAL_GUILDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, GuildState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalGuilds(guilds: Record<string, GuildState>) {
  localStorage.setItem(LOCAL_GUILDS_KEY, JSON.stringify(guilds));
}

function localGuildId() {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local-guild-${id}`;
}

function localMember(profile: PlayerProfile, role: GuildMember["role"]): GuildMember {
  return {
    id: profile.uid,
    nickname: profile.nickname,
    animal: profile.mainCharacter,
    role,
    weeklyContribution: 0,
    joinedAt: new Date().toISOString(),
  };
}

export async function getGuild(profile: PlayerProfile): Promise<GuildState> {
  if (profile.authMode === "firebase") {
    const result = await callGuildFunction<Record<string, never>, GuildState>("getGuild", {});
    if (result) return result;
  }

  const guildId = localStorage.getItem(userGuildKey(profile.uid));
  if (!guildId) return { guild: null, boss: null, members: [] };
  return readLocalGuilds()[guildId] || { guild: null, boss: null, members: [] };
}

export async function createGuild(
  profile: PlayerProfile,
  name: string,
  description = "",
): Promise<GuildState> {
  const guildName = sanitizeGuildName(name);
  if (guildName.length < 2) throw new Error("길드 이름은 2자 이상이에요.");

  if (profile.authMode === "firebase") {
    const result = await callGuildFunction<{ name: string; description: string }, GuildState>(
      "createGuild",
      { name: guildName, description: sanitizeGuildDescription(description) },
    );
    if (result) return result;
  }

  const guildId = localGuildId();
  const boss = defaultBoss(1);
  const state: GuildState = {
    guild: {
      id: guildId,
      name: guildName,
      description: sanitizeGuildDescription(description) || "함께 보스를 공략해요.",
      ownerId: profile.uid,
      level: 1,
      memberCount: 1,
      weeklyScore: 0,
      rank: 0,
      boss,
    },
    boss,
    members: [localMember(profile, "leader")],
  };
  const guilds = readLocalGuilds();
  writeLocalGuilds({ ...guilds, [guildId]: state });
  localStorage.setItem(userGuildKey(profile.uid), guildId);
  return state;
}

export async function joinGuild(profile: PlayerProfile, guildId: string): Promise<GuildState> {
  const cleanGuildId = guildId.trim();
  if (!cleanGuildId) throw new Error("길드 ID를 입력해주세요.");

  if (profile.authMode === "firebase") {
    const result = await callGuildFunction<{ guildId: string }, GuildState>("joinGuild", {
      guildId: cleanGuildId,
    });
    if (result) return result;
  }

  const guilds = readLocalGuilds();
  const state = guilds[cleanGuildId];
  if (!state?.guild) throw new Error("길드를 찾지 못했어요.");
  const members = state.members.filter((member) => member.id !== profile.uid);
  const nextState: GuildState = {
    ...state,
    guild: { ...state.guild, memberCount: members.length + 1 },
    members: [localMember(profile, "member"), ...members],
  };
  writeLocalGuilds({ ...guilds, [cleanGuildId]: nextState });
  localStorage.setItem(userGuildKey(profile.uid), cleanGuildId);
  return nextState;
}

export async function leaveGuild(profile: PlayerProfile): Promise<GuildState> {
  if (profile.authMode === "firebase") {
    const result = await callGuildFunction<Record<string, never>, GuildState>("leaveGuild", {});
    if (result) return result;
  }

  const guildId = localStorage.getItem(userGuildKey(profile.uid));
  if (!guildId) return { guild: null, boss: null, members: [] };
  const guilds = readLocalGuilds();
  const state = guilds[guildId];
  if (state?.guild?.ownerId === profile.uid) {
    delete guilds[guildId];
  } else if (state?.guild) {
    const members = state.members.filter((member) => member.id !== profile.uid);
    guilds[guildId] = {
      ...state,
      guild: { ...state.guild, memberCount: members.length },
      members,
    };
  }
  writeLocalGuilds(guilds);
  localStorage.removeItem(userGuildKey(profile.uid));
  return { guild: null, boss: null, members: [] };
}

export async function kickGuildMember(
  profile: PlayerProfile,
  memberId: string,
): Promise<GuildState> {
  const targetId = memberId.trim();
  if (!targetId || targetId === profile.uid) {
    throw new Error("내보낼 멤버를 선택해주세요.");
  }

  if (profile.authMode === "firebase") {
    const result = await callGuildFunction<{ userId: string }, { removed: boolean }>(
      "kickGuildMember",
      { userId: targetId },
    );
    if (result?.removed) return getGuild(profile);
  }

  const guildId = localStorage.getItem(userGuildKey(profile.uid));
  if (!guildId) throw new Error("가입한 길드가 없어요.");
  const guilds = readLocalGuilds();
  const state = guilds[guildId];
  if (!state?.guild || state.guild.ownerId !== profile.uid) {
    throw new Error("길드장만 멤버를 내보낼 수 있어요.");
  }
  const members = state.members.filter((member) => member.id !== targetId);
  if (members.length === state.members.length) throw new Error("길드 멤버를 찾지 못했어요.");
  const nextState: GuildState = {
    ...state,
    guild: { ...state.guild, memberCount: members.length },
    members,
  };
  writeLocalGuilds({ ...guilds, [guildId]: nextState });
  localStorage.removeItem(userGuildKey(targetId));
  return nextState;
}

export async function recordGuildContribution(profile: PlayerProfile, score: number) {
  if (profile.authMode === "firebase") return null;
  const guildId = localStorage.getItem(userGuildKey(profile.uid));
  if (!guildId) return null;
  const guilds = readLocalGuilds();
  const state = guilds[guildId];
  if (!state?.guild || !state.boss) return null;
  const damage = Math.max(1, Math.floor(Math.max(0, Math.round(score)) / 100));
  const boss = { ...state.boss, hp: Math.max(0, state.boss.hp - damage) };
  const members = state.members.map((member) =>
    member.id === profile.uid
      ? { ...member, weeklyContribution: member.weeklyContribution + damage }
      : member,
  );
  const nextState = {
    ...state,
    boss,
    guild: {
      ...state.guild,
      boss,
      weeklyScore: state.guild.weeklyScore + damage,
    },
    members,
  };
  writeLocalGuilds({ ...guilds, [guildId]: nextState });
  return { guildId, damage, boss };
}
