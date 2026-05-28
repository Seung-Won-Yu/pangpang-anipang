import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";
import type { CharacterId, PlayerProfile } from "./player";

const LOCAL_FRIENDS_PREFIX = "ani-pang-friends";

export interface FriendEntry {
  id: string;
  nickname: string;
  animal: CharacterId;
  bestScore: number;
  online: boolean;
  isOnline: boolean;
  lastSeen: string | null;
}

async function callSocialFunction<Input, Output>(name: string, data: Input) {
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

function localKey(uid: string) {
  return `${LOCAL_FRIENDS_PREFIX}:${uid}`;
}

function localFriendCode(profile: PlayerProfile) {
  return profile.uid
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-6)
    .padStart(6, "0")
    .toUpperCase();
}

function readLocalFriends(profile: PlayerProfile): FriendEntry[] {
  try {
    const raw = localStorage.getItem(localKey(profile.uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FriendEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch {
    return [];
  }
}

function writeLocalFriends(profile: PlayerProfile, friends: FriendEntry[]) {
  localStorage.setItem(localKey(profile.uid), JSON.stringify(friends.slice(0, 100)));
}

export async function getFriendCode(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    const result = await callSocialFunction<Record<string, never>, { code: string }>(
      "getFriendCode",
      {},
    );
    if (result) return result.code;
  }

  return localFriendCode(profile);
}

export async function getFriends(profile: PlayerProfile) {
  if (profile.authMode === "firebase") {
    const result = await callSocialFunction<Record<string, never>, { friends: FriendEntry[] }>(
      "getFriends",
      {},
    );
    if (result) return result.friends;
  }

  return readLocalFriends(profile);
}

export async function inviteFriend(profile: PlayerProfile, code: string) {
  const friendCode = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (profile.authMode === "firebase") {
    const result = await callSocialFunction<{ code: string }, { friend: FriendEntry }>(
      "inviteFriend",
      { code: friendCode },
    );
    if (result) return result.friend;
  }

  if (friendCode.length !== 6) throw new Error("친구 코드는 6자리예요.");
  if (friendCode === localFriendCode(profile)) throw new Error("내 코드는 추가할 수 없어요.");

  const friend: FriendEntry = {
    id: `local-friend-${friendCode}`,
    nickname: `친구 ${friendCode}`,
    animal: "cat",
    bestScore: 0,
    online: false,
    isOnline: false,
    lastSeen: null,
  };
  const friends = readLocalFriends(profile).filter((item) => item.id !== friend.id);
  writeLocalFriends(profile, [friend, ...friends]);
  return friend;
}

export async function acceptFriend(profile: PlayerProfile, friendId: string) {
  if (profile.authMode === "firebase") {
    const result = await callSocialFunction<{ friendId: string }, { friend: FriendEntry }>(
      "acceptFriend",
      { friendId },
    );
    if (result) return result.friend;
  }

  return readLocalFriends(profile).find((friend) => friend.id === friendId) ?? null;
}

export async function blockUser(profile: PlayerProfile, userId: string) {
  if (profile.authMode === "firebase") {
    const result = await callSocialFunction<{ userId: string }, { blocked: boolean }>("blockUser", {
      userId,
    });
    if (result?.blocked) return true;
  }
  writeLocalFriends(
    profile,
    readLocalFriends(profile).filter((friend) => friend.id !== userId),
  );
  return true;
}

export async function reportPlayer(
  profile: PlayerProfile,
  userId: string,
  reason: "cheat" | "abuse" | "spam" | "nickname" | "other" = "other",
) {
  if (profile.authMode === "firebase") {
    const result = await callSocialFunction<
      { userId: string; reason: string },
      { reported: boolean }
    >("reportPlayer", { userId, reason });
    if (result?.reported) return true;
  }
  return true;
}

export async function removeFriend(profile: PlayerProfile, friendId: string) {
  if (profile.authMode === "firebase") {
    const result = await callSocialFunction<{ friendId: string }, { removed: boolean }>(
      "removeFriend",
      { friendId },
    );
    if (result?.removed) return true;
  }

  writeLocalFriends(
    profile,
    readLocalFriends(profile).filter((friend) => friend.id !== friendId),
  );
  return true;
}
