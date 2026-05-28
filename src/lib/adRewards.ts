import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";
import { MAX_HEARTS, persistPlayerProfile, type PlayerProfile } from "./player";

export type AdRewardType = "heart" | "timePlus" | "coins" | "booster";

export interface AdRewardResult {
  granted: boolean;
  alreadyGranted: boolean;
  profile: PlayerProfile;
  rewards: Partial<Record<"hearts" | "coins" | "timePlus" | "hint", number>>;
}

async function callAdRewardFunction<Input, Output>(name: string, data: Input) {
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

export async function claimAdReward(
  profile: PlayerProfile,
  rewardType: AdRewardType,
): Promise<AdRewardResult> {
  if (profile.authMode === "firebase") {
    const result = await callAdRewardFunction<
      { rewardType: AdRewardType; rewardId: string },
      AdRewardResult
    >("claimAdReward", {
      rewardType,
      rewardId: `${rewardType}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    });
    if (result) return result;
  }

  let nextProfile = { ...profile };
  const inventory = { ...profile.inventory };
  const rewards: AdRewardResult["rewards"] = {};
  if (rewardType === "heart") {
    nextProfile.hearts = Math.min(MAX_HEARTS, profile.hearts + 1);
    rewards.hearts = nextProfile.hearts > profile.hearts ? 1 : 0;
  } else if (rewardType === "coins") {
    nextProfile.coins = profile.coins + 30;
    rewards.coins = 30;
  } else if (rewardType === "timePlus") {
    inventory.timePlus += 1;
    rewards.timePlus = 1;
  } else {
    inventory.hint += 1;
    rewards.hint = 1;
  }
  nextProfile = { ...nextProfile, inventory };
  await persistPlayerProfile(nextProfile);
  return { granted: true, alreadyGranted: false, profile: nextProfile, rewards };
}
