# PangPang Anipang

동물 블록을 연결해 즐기는 React 기반 매치 퍼즐 프로토타입입니다. 60초 러시, 스테이지, 대전 모드와 로비·캐릭터·미션·랭킹 흐름을 구현했으며, Firebase가 없어도 로컬 모드로 플레이할 수 있습니다.

**React 19** · **TypeScript** · **Vite** · **Tailwind CSS** · **Firebase**

![PangPang Anipang 로비](docs/images/pangpang-anipang-home.png)

## 프로젝트 개요

| 영역 | 구현 내용 |
| --- | --- |
| 게임 플레이 | 매치, 콤보, 피버, 4·5매치 특수 블록과 아이템 |
| 플레이 모드 | 60초 러시, 스테이지 진행, 로컬·온라인 대전 |
| 메타 시스템 | 출석, 일일·주간 미션, 시즌 패스, 상점, 캐릭터 도감 |
| 소셜 | 친구 코드, 친구 랭킹, 프로필과 공유 |
| 저장 방식 | 기본 localStorage, 선택적 Firebase Auth·Firestore·Functions |

## 핵심 기능

- 드래그 기반 블록 교환과 연쇄 매치
- 콤보·피버·특수 블록에 따른 점수 보너스
- 단계별 목표와 별점으로 이어지는 스테이지 진행
- 로컬 봇 또는 Firebase Functions를 이용한 대전 세션
- 오늘·주간·전체 범위의 로컬/온라인 랭킹
- Google·Apple·Kakao 계정 연결을 고려한 Firebase 인증 구조
- Firebase 연결이 없거나 실패해도 로컬 데이터로 계속 동작하는 fallback

## 빠른 시작

```bash
npm install
npm run dev
```

개발 서버는 기본적으로 `http://127.0.0.1:5174/`에서 실행됩니다.

프로덕션 빌드와 미리보기:

```bash
npm run build
npm run preview
```

## Firebase 연결

Firebase 없이도 게스트·로컬 모드로 실행할 수 있습니다. 온라인 계정, 랭킹, 친구, 대전 기능을 연결하려면 환경 파일을 준비합니다.

```bash
cp .env.example .env.local
```

필요한 Firebase 값을 `.env.local`에 입력한 뒤 기능 플래그를 활성화합니다. 비밀값과 로컬 환경 파일은 Git에 커밋하지 않습니다.

## 품질 확인

```bash
npm ci
npm --prefix functions ci
npm run lint
npm run typecheck
npm run verify
```

`npm run verify`는 프론트엔드 lint·type check·build와 Cloud Functions build·lint를 순서대로 실행합니다. 전체 검증 전에는 루트와 `functions/`의 의존성을 각각 설치해야 합니다.

## 프로젝트 구조

```text
src/game/            보드 엔진, 화면과 게임 상태
src/lib/             플레이어, 랭킹, 대전, 미션, 소셜, Firebase 연결
src/assets/          동물 캐릭터와 UI 이미지
functions/src/       Firebase Callable Functions
docs/images/         README 화면 이미지
firestore.rules      Firestore 접근 규칙
DEPLOY.md            Cloudflare Pages·Firebase 배포 절차
```

## 배포

정적 프론트엔드는 Cloudflare Pages, 선택적 백엔드는 Firebase로 분리할 수 있습니다. 실제 명령과 환경별 주의사항은 [DEPLOY.md](DEPLOY.md)를 참고하세요.

## 상태

게임과 주요 메타 시스템을 검증하기 위한 프로토타입입니다. 외부 서비스 없이 로컬 플레이가 가능하며, 운영 환경에서는 Firebase 프로젝트·인증 제공자·Firestore 규칙·Functions 배포를 별도로 구성해야 합니다.
