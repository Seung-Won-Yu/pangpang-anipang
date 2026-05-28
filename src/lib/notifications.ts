import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";
import type { PlayerProfile } from "./player";

const LOCAL_NOTIFICATION_PREFIX = "ani-pang-notifications";

export type NotificationTopic = "heart_full" | "friend_score" | "daily_reminder" | "season_ending";

export interface NotificationPreferences {
  pushEnabled: boolean;
  topics: NotificationTopic[];
}

const defaultPreferences: NotificationPreferences = {
  pushEnabled: true,
  topics: ["heart_full", "daily_reminder"],
};

async function callNotificationFunction<Input, Output>(name: string, data: Input) {
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
  return `${LOCAL_NOTIFICATION_PREFIX}:${uid}`;
}

function normalizeTopics(topics: NotificationTopic[]) {
  const allowed: NotificationTopic[] = [
    "heart_full",
    "friend_score",
    "daily_reminder",
    "season_ending",
  ];
  return topics.filter((topic, index, list) => {
    return allowed.includes(topic) && list.indexOf(topic) === index;
  });
}

export async function getNotificationPreferences(
  profile: PlayerProfile,
): Promise<NotificationPreferences> {
  if (profile.authMode === "firebase") {
    const result = await callNotificationFunction<Record<string, never>, NotificationPreferences>(
      "getNotificationPreferences",
      {},
    );
    if (result) return result;
  }

  try {
    const raw = localStorage.getItem(localKey(profile.uid));
    if (!raw) return defaultPreferences;
    const parsed = JSON.parse(raw) as NotificationPreferences;
    return {
      pushEnabled: parsed.pushEnabled !== false,
      topics: normalizeTopics(parsed.topics || defaultPreferences.topics),
    };
  } catch {
    return defaultPreferences;
  }
}

export async function updateNotificationPreferences(
  profile: PlayerProfile,
  preferences: NotificationPreferences,
): Promise<NotificationPreferences> {
  const nextPreferences = {
    pushEnabled: preferences.pushEnabled,
    topics: normalizeTopics(preferences.topics),
  };
  if (profile.authMode === "firebase") {
    const result = await callNotificationFunction<NotificationPreferences, NotificationPreferences>(
      "updateNotificationTopics",
      nextPreferences,
    );
    if (result) return result;
  }

  localStorage.setItem(localKey(profile.uid), JSON.stringify(nextPreferences));
  return nextPreferences;
}
