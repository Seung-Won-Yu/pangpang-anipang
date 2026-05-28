# Cloudflare Pages and Firebase Setup

## Cloudflare Pages deploy

Use Cloudflare Pages for the static app build. The free MVP uses Firebase
Anonymous Auth, Firestore, and Firestore Rules. Callable Cloud Functions are
optional later when server-side score validation, anti-cheat, purchases, or
trusted economy checks become necessary.

- Framework preset: `Vite`
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `20.20.2` or newer

If the Pages project is using an older build image, add this environment variable:

```bash
NODE_VERSION=20.20.2
```

Cloudflare Pages copies files from `public/` into `dist/` during the Vite build. The committed `public/_headers` file adds basic browser security headers and long-term caching for hashed Vite assets.

## Cloudflare environment variables

Add these under Cloudflare Pages > your project > Settings > Environment variables.

```bash
VITE_FIREBASE_ENABLED=true
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_USE_FUNCTIONS=false
```

Set them for Production. Add Preview values too if preview deployments should use the same Firebase project.

The Firebase web config is public in the browser build. Security comes from Firebase Authentication and Firestore Rules, not from hiding these values.

## Local Firebase mode

Use `.env.local` for local development. To force local-only guest mode while Firebase is not ready:

```bash
VITE_FIREBASE_ENABLED=false
```

When Firebase is ready locally, set `VITE_FIREBASE_ENABLED=true` or remove the flag and provide all `VITE_FIREBASE_*` values.

## Firebase checklist

1. Firebase Console > Project settings > General > Your apps: create or confirm the Web app.
2. Copy the Web SDK config fields into Cloudflare Pages environment variables.
3. Authentication > Sign-in method: enable Anonymous.
4. Authentication > Sign-in method: enable Google and Apple if account linking should be available.
5. For Kakao linking, configure a Firebase OIDC provider with provider ID `oidc.kakao`.
6. Authentication > Settings > Authorized domains: add the Cloudflare Pages domain and any custom domain.
7. Firestore Database: create a database in production mode.
8. Cloud Functions: keep `VITE_FIREBASE_USE_FUNCTIONS=false` for the free MVP. Upgrade the project to a plan that supports Cloud Functions only when trusted server validation is needed.
9. For Google Play IAP verification, grant the Functions service account access to the Play Console app and set:

```bash
GOOGLE_PLAY_PACKAGE_NAME=com.yourcompany.pangpang
```

10. For App Store IAP verification, create an App Store Server API key and set these Functions environment variables or secrets:

```bash
APPLE_IAP_ISSUER_ID=...
APPLE_IAP_KEY_ID=...
APPLE_IAP_BUNDLE_ID=com.yourcompany.pangpang
APPLE_IAP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
APPLE_IAP_ENVIRONMENT=production
```

11. Install dependencies and run local gates:

```bash
npm install
npm install --prefix functions
npm run verify
```

12. Deploy Firestore rules for the free MVP:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
firebase deploy --only firestore:rules
```

Deploy callable functions separately only after enabling a billing plan:

```bash
firebase deploy --only functions
```

The committed `firestore.rules` for the free MVP allows public leaderboard reads, owner-only profile reads, owner-only profile writes under `users/{uid}`, and authenticated score writes under `scores/{runId}`. This keeps the deployment on Firebase Auth + Firestore only. Economy and score values are client-submitted in this mode, so it is meant for playability validation before trusted anti-cheat or purchase logic.

## Optional trusted backend mode

The callable Functions architecture below is the paid/trusted upgrade path. Enable it only after setting `VITE_FIREBASE_USE_FUNCTIONS=true` and deploying Functions on a Firebase plan that supports them.

Guest accounts are created with Firebase Anonymous Auth in the web app. For clients that need the REST shape from `BACKEND_TASKS.md`, the `api` HTTP function exposes `POST /auth/login`, `POST /auth/refresh`, `POST /auth/link`, `POST /auth/restore`, `GET /auth/me`, and `DELETE /auth/me`. Set `JWT_SESSION_SECRET` to a 32+ character secret; access JWTs expire in 24 hours and refresh tokens expire in 30 days, are stored only as hashes under `authRefreshTokens`, and rotate on every refresh. The lobby account panel can link the current anonymous user to Google, Apple, or Kakao so the same Firebase UID keeps its profile, stage progress, inventory, and ranking history. After a successful link, the `syncAccountProviders` callable writes the provider list back to the user profile. For temporary device migration, `createRestoreCode` creates a 10-minute one-time restore code and `restorePlayerProfile` or `POST /auth/restore` copies that profile into the currently signed-in user; direct client access to `restoreCodes` and `authRefreshTokens` is denied. `deletePlayerAccount` and `DELETE /auth/me` remove the user profile, known progress/reward rows, friend links, score/match rows, restore/friend codes, refresh tokens, and then delete the Firebase Auth user.

The same `api` HTTP function also exposes the P0 gameplay/account endpoints from the backend spec: `GET/PATCH /me/profile`, `GET /me/stats`, `POST /me/heart/consume`, `POST /me/heart/refill`, `POST /me/heart/timer-claim`, `POST /match/start`, `POST /match/finish`, `GET /shop/items`, and `POST /iap/verify`. These REST routes reuse the same Firestore/Admin SDK authority model as the callable APIs. `POST /match/finish` verifies the match and, when accepted for the first time, grants progress rewards and writes the leaderboard row idempotently.

Privacy export is served by `exportPlayerData`, which returns the signed-in user's profile, stats, progress, social rows, gameplay rows, commerce history, season reward grants, notification preferences/token hashes, and moderation/report rows with Firestore timestamps converted to ISO strings. Raw push tokens are not included in the export payload. The account panel downloads this payload as JSON.

In-app purchases are verified server-side through the `verifyIapPurchase` callable. Android purchases are checked with the Google Play Developer API `purchases.products.get` endpoint. iOS purchases are checked with Apple App Store Server API `Get Transaction Info`. The client must send the store `productId` plus the Google `purchaseToken` or Apple `transactionId`; Functions records each verified transaction under `iapTransactions` and grants rewards only once. The built-in IAP grants include `starter_pack`, `season_pass_s2`, and `vip_monthly`; VIP entitlement is stored as `vipUntil` on the user profile.

Season pass state is served by `getSeasonPassStatus` and claimed through `claimSeasonPassReward`. REST equivalents are available at `GET /pass/current`, `POST /pass/claim`, and `POST /pass/purchase-premium`. Claims are stored under `seasonPassClaims/{uid}` by Admin SDK only; the client can read its own pass state but cannot write claim rows directly. The premium track opens only when the server-side IAP grant sets `seasonPassPremium` on the user profile.

Daily check-in state is served by `getDailyCheckinStatus` and claimed through `claimDailyCheckin`. Today mission state is served by `getDailyMissionStatus` and can be claimed through `claimDailyMission`. Weekly mission state is served by `getWeeklyMissionStatus` and claimed through `claimWeeklyMission`; `recordRunProgress` accumulates weekly progress from accepted match metrics. REST equivalents are available at `GET/POST /daily/checkin/*`, `GET /missions/today`, `GET /missions/week`, and `POST /missions/{id}/claim`. Check-in and mission rows live under `dailyCheckins/{uid}`, `dailyMissions/{uid}`, and `weeklyMissions/{uid}` and are Admin SDK write-only.

Match sessions are created by `startMatchSession` and closed by `finishMatchSession`; direct client writes to `matches` are denied. `finishMatchSession` checks the server-issued seed, ownership, duration, replay size/timing, adjacent board moves, coarse score plausibility, and player level/history anomaly caps before marking a match accepted. Player progress rewards and leaderboard submissions are tied to accepted matches: `recordRunProgress` marks `rewardsClaimed` once, and `submitLeaderboardScore` writes `scores/{matchId}` only for accepted matches.

Async versus starts with `queueVersus` or `POST /versus/queue`, which creates a server-owned `matches/{matchId}` row plus a matching `versusMatches/{matchId}` row with the selected opponent target. After `finishMatchSession` accepts the run and `recordRunProgress` claims the normal run reward, `finishVersus` or `POST /versus/finish` settles win/loss, RP, and bonus stars exactly once. Direct client writes to `versusMatches` are denied.

Friend codes are served by `getFriendCode` or `GET /friends/code`, friend lists by `getFriends` or `GET /friends`, and mutual friend links by `inviteFriend`, `acceptFriend`, `removeFriend`, `POST /friends/invite`, `POST /friends/accept`, and `DELETE /friends/{id}`. Contact matching uses explicit-consent hashed contacts through `updateContactHashes`, `getContactMatches`, and `GET/POST /friends/contacts`. Friend code, friendship, request, contact hash, block, report, and ban documents are Admin SDK controlled; clients can read only their own friend rows and cannot write them directly.

Moderation is handled by `blockUser`, `unblockUser`, `getBlockedUsers`, `reportPlayer`, and `getModerationStatus`. Blocks remove existing friend links and prevent new invites between the two users. Bans are controlled by server/admin-owned `moderationBans/{uid}` rows; gameplay, social, guild, ad reward, and economy-changing callables reject active bans.

Stage progress is served by `getStageProgress` and written only by `clearStage`, with REST equivalents at `GET /stages/progress` and `POST /stages/clear`. Character collection state is served by `getCharacterDex`, while `setMainCharacter` and `levelUpCharacter` own character changes and costs; REST equivalents are `GET /characters/dex`, `POST /characters/main`, and `POST /characters/level-up`. Direct client writes to stage and character economy fields are denied.

Guild state is served by `getGuild` or `GET /guilds/me`. `createGuild`, `joinGuild`, `leaveGuild`, `kickGuildMember`, `POST /guilds`, `POST /guilds/{id}/join`, `POST /guilds/{id}/leave`, and `POST /guilds/{id}/kick` own membership writes under `guilds`, `guildMembers`, and `userGuilds`; kicks are restricted to the guild owner. `GET /guilds/{id}/members` and `GET /guilds/{id}/boss` are restricted to members of that guild. Accepted match rewards automatically add weekly boss damage during `recordRunProgress`; `hitGuildBoss` and `POST /guilds/{id}/boss/hit` exist for accepted matches that still need a guild boss claim. Direct client writes to guild collections are denied.

Live operations config is served by `getLiveOpsConfig` or `GET /liveops/config`, combining `liveConfig/seasonCurrent`, `liveConfig/shopItems`, `liveConfig/eventBanners`, and deterministic per-user experiment variants for shop price, reward amount, and tutorial flow tests. `getSeasonCurrent` and `getShopItems` are also exposed as narrower callable APIs for the design's season and shop screens. Direct live config reads are still allowed for non-sensitive display metadata; writes are denied.

Notification settings are served by `getNotificationPreferences` or `GET /notifications/topics` and updated through `updateNotificationTopics` or `PATCH /notifications/topics`. `registerNotificationToken` and `POST /notifications/register` store FCM/APNs/web push tokens server-side with token hashes, platform, and topic list. `sendPushCampaign` is restricted to UIDs listed in `LIVEOPS_ADMIN_UIDS` and can dry-run or send a topic campaign through Firebase Cloud Messaging. Direct client access to notification token, campaign, and preference documents is denied.

Rewarded ads are granted through `claimAdReward` or `POST /ads/reward`, with per-user daily counters and idempotent reward IDs stored server-side. Set `AD_REWARD_SSV_SECRET` to require HMAC-SHA256 SSV signatures over `uid:rewardId:rewardType:timestamp:nonce`; without that secret, the callable remains in `client_verified` development mode for local testing. Production provider callbacks are exposed at `GET /ads/ssv/admob` and `GET /ads/ssv/unity`: AdMob callbacks verify ECDSA signatures against the Google key server and cache public keys for under 24 hours, Unity LevelPlay callbacks verify `md5(timestamp + eventId + userId + rewards + UNITY_LEVELPLAY_SSV_SECRET)`, and legacy Unity Ads callbacks verify the sorted-parameter `hmac` with `UNITY_ADS_SSV_SECRET`. Configure the ad network callback `user_id`/`userid` to the Firebase UID and map the ad reward item name to `heart`, `coins`, `timePlus`, or `booster`.

High-frequency backend actions use server-side rate limit rows under `rateLimits`, including match start, async versus queueing, weekly mission claims, friend invites, guild create/join/kick, and rewarded ad claims. Direct client access to these rows is denied.

Telemetry events are accepted through `logTelemetryEvent` or `POST /telemetry/events` for the whitelisted event names in `BACKEND_TASKS.md`; payloads are shallow-sanitized before writing to `telemetryEvents`.

Leaderboard reads can use the `getLeaderboard` callable or `GET /ranking?range=today|weekly|all&scope=global|friends`. The friends scope filters scores to the current user plus their server-stored friend links. `GET /season/current` serves the current season meta for D-day displays. Weekly season rewards are settled idempotently by the scheduled `settleWeeklySeasonRewards` function every Monday 00:10 KST, and operators listed in `LIVEOPS_ADMIN_UIDS` can run `settleSeasonRewards` manually for weekly or all-time ranges.

For local rules parsing, the Firestore emulator requires Java:

```bash
java -version
npx firebase-tools emulators:exec --only firestore --project demo-pangpang-anipang "echo rules-ok"
```

If Java is missing, install a current JDK before relying on emulator-based rules checks.

## Common Firebase errors

- `CONFIGURATION_NOT_FOUND`: the Web app config does not match an enabled Firebase project, or the API key/app ID/project ID came from the wrong project.
- Auth works locally but fails on Cloudflare: add the Pages/custom domain under Firebase Authentication authorized domains.
- Auth works but profile reads fail: confirm `firestore.rules` has been published after the latest rules change.
- Meta actions fail with `functions/not-found`: keep `VITE_FIREBASE_USE_FUNCTIONS=false` for the free MVP, or deploy Cloud Functions before turning it on.
- Meta actions fail with `functions/unauthenticated`: confirm Anonymous Auth is enabled and the browser session signed in successfully.
- Account linking fails after the provider popup: enable that provider in Firebase Authentication and confirm the domain is listed under authorized domains.
- Kakao linking fails immediately: confirm the OIDC provider ID is exactly `oidc.kakao`.
- IAP verification fails with a Functions precondition error: confirm the Google package name or Apple key/bundle environment variables are configured in the deployed Functions runtime.
- IAP verification returns already granted: the transaction was accepted earlier and is intentionally idempotent.
- Pass rewards fail with `functions/not-found`: deploy the latest Functions so `getSeasonPassStatus` and `claimSeasonPassReward` exist in the active Firebase project.
- Today or weekly mission does not complete after a valid run: deploy the latest `recordRunProgress`, `getDailyMissionStatus`, `claimDailyMission`, `getWeeklyMissionStatus`, and `claimWeeklyMission` Functions and confirm the browser is using the same Firebase project as the deployed functions.
- Match rewards, versus, or rankings fail after a game: deploy `startMatchSession`, `finishMatchSession`, `queueVersus`, `finishVersus`, `recordRunProgress`, and `submitLeaderboardScore` together; Firestore direct writes to `matches`, `versusMatches`, and `scores` are intentionally denied.
- Guild panel fails to load, a kick fails, or boss damage stays unchanged: deploy `getGuild`, `createGuild`, `joinGuild`, `leaveGuild`, `kickGuildMember`, `hitGuildBoss`, and the latest `recordRunProgress`; direct client writes to guild collections are intentionally denied.
- Push/ad/telemetry calls fail with `functions/not-found`: deploy `getNotificationPreferences`, `updateNotificationTopics`, `registerNotificationToken`, `claimAdReward`, and `logTelemetryEvent`.
- Rankings stay local: confirm Anonymous Auth is enabled, `VITE_FIREBASE_ENABLED` is not `false`, and the latest Firestore rules are deployed.
- Firestore writes are denied after enabling Firebase: confirm `firebase deploy --only firestore:rules` succeeded and the build uses the same Firebase project ID.

## Notes

The old `netlify.toml` is not used by Cloudflare Pages. It can stay harmlessly in the repo, but Cloudflare settings should follow this document.
