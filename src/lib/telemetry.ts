import { isFirebaseConfigured, useFirebaseFunctions } from "./firebaseConfig";

export type TelemetryEventName =
  | "session_start"
  | "session_end"
  | "match_start"
  | "match_finish"
  | "purchase"
  | "tutorial_step"
  | "mission_claim"
  | "daily_claim"
  | "pass_claim"
  | "ad_request"
  | "ad_view"
  | "ad_reward";

async function callTelemetryFunction<Input, Output>(name: string, data: Input) {
  if (!isFirebaseConfigured || !useFirebaseFunctions) return null;
  const [functionsApi, firebase] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  if (!firebase.firebaseApp) return null;
  const fn = functionsApi.httpsCallable<Input, Output>(
    functionsApi.getFunctions(firebase.firebaseApp),
    name,
  );
  const result = await fn(data);
  return result.data;
}

export async function logTelemetryEvent(
  name: TelemetryEventName,
  payload: Record<string, string | number | boolean | null> = {},
) {
  try {
    await callTelemetryFunction<
      { name: TelemetryEventName; payload: typeof payload },
      { logged: boolean }
    >("logTelemetryEvent", { name, payload });
  } catch {
    // Telemetry should never block gameplay.
  }
}
