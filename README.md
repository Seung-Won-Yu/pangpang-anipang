# PangPang Anipang

A match-style web game prototype with a playful lobby, character assets, local play, and optional Firebase-backed ranking/account features.

![PangPang Anipang lobby screenshot](docs/images/pangpang-anipang-home.png)

## Highlights

- Match-style browser gameplay
- React + TypeScript + Vite frontend
- Local-only mode for quick playtesting
- Optional Firebase Auth, Firestore, and Cloud Functions integration
- Deployment notes for Cloudflare Pages and Firebase

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Firebase
- Cloudflare Pages

## Getting Started

```sh
npm install
npm run dev
```

Open the local URL printed by Vite.

## Build

```sh
npm run build
```

## Firebase Setup

The project can run without Firebase by default. Copy `.env.example` to `.env.local` and fill in Firebase values only when you want to enable backend features.

```sh
cp .env.example .env.local
```

For deployment details, see [DEPLOY.md](DEPLOY.md).

## Notes

Local environment files, build outputs, dependency folders, generated archives, and deployment cache folders are intentionally excluded from Git.
