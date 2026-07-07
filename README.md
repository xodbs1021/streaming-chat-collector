# streaming-chat-collector

치지직(CHZZK)과 SOOP의 라이브 채팅을 동시에 수집해서 실시간으로 분석하는 대시보드다. "채팅이 폭발한 순간 = 하이라이트"라는 가설로 방송 다시보기 편집 지점을 자동으로 찾는 게 목적이며, e스포츠 중계처럼 채팅 리듬이 뚜렷한 방송에서 특히 잘 맞는다.

## 기능

- **실시간 채팅 수집**: 치지직(공식 OAuth API / 비공식 웹소켓 어댑터 선택 가능), SOOP 웹소켓 동시 연결
- **실시간 분석 대시보드**: 초 단위 윈도우 막대그래프(1/3/5/10초), 참여율(같은 기간 유니크 채팅러 ÷ 평균 시청자 수), 하이라이트 후보 자동 감지, 키워드 추적
- **방송 화면 프레임 캡처**: ffmpeg로 HLS 스트림에서 1fps 프레임을 뽑아 타임라인 호버/클릭 시 해당 순간의 실제 화면을 확인 가능
- **세션 녹화**: 채팅 로그를 JSONL로 디스크에 저장, CSV/JSON으로 내보내기
- **OBS 오버레이**: 방송 화면에 얹을 수 있는 채팅 오버레이 뷰
- **하이라이트 마커**: 라이브 중 또는 다시보기에서 구간 마커를 찍고 라벨링

## 기술 스택

- **서버**: Fastify + socket.io (Node.js, TypeScript)
- **클라이언트**: React 19 + Vite
- **테스트**: Vitest(유닛), Playwright(E2E)
- **프레임 캡처**: ffmpeg (외부 바이너리, 선택적 의존성)

## 사전 준비물

- Node.js 20 이상
- [pnpm](https://pnpm.io/)
- (선택) [ffmpeg](https://ffmpeg.org/) — 방송 화면 프레임 캡처 기능을 쓰려면 설치 필요 (`brew install ffmpeg`). 없어도 채팅 수집/분석 기능은 정상 동작하고, 캡처만 자동으로 비활성화된다.
- (선택) 치지직 개발자 센터에서 발급받은 OAuth Client ID/Secret — 공식 API 모드를 쓸 때만 필요. 비공식 모드는 채널 ID만으로 동작한다.

## 설치 및 실행

```bash
pnpm install
cp .env.example .env   # 필요한 값 채우기 (아래 환경 변수 표 참고)

# 개발 모드 — 서버와 클라이언트를 각각 별도 터미널에서 실행
pnpm dev          # API 서버 (Fastify, tsx watch) — http://localhost:4010
pnpm dev:client   # 클라이언트 (Vite) — 브라우저는 이 포트로 접속할 것

# 프로덕션 빌드 및 실행
pnpm build
pnpm start
```

> 개발 중에는 반드시 **`dev:client`(Vite) 포트로 브라우저에 접속**해야 한다. API 서버(`dev`) 포트로 직접 들어가면 정적 자산 요청이 SPA 폴백에 걸려 빈 화면과 함께 모듈 스크립트 MIME 에러가 뜬다.

## 환경 변수 (`.env`)

| 변수 | 필수 | 설명 |
|---|---|---|
| `PORT` | - | API 서버 포트 (기본 4010) |
| `HOST` | - | API 서버 바인드 호스트 (기본 127.0.0.1) |
| `PUBLIC_BASE_URL` | - | 서버의 외부 접근 URL (기본 `http://localhost:{PORT}`) |
| `FRONTEND_ORIGIN` | - | CORS 허용 오리진 (기본 `PUBLIC_BASE_URL`과 동일) |
| `CHZZK_CLIENT_ID` | 공식 모드만 | 치지직 개발자 센터에서 발급받은 OAuth Client ID |
| `CHZZK_CLIENT_SECRET` | 공식 모드만 | 치지직 개발자 센터에서 발급받은 OAuth Client Secret — **절대 커밋하지 말 것** |
| `CHZZK_REDIRECT_URI` | 공식 모드만 | OAuth 콜백 URL (기본 `{PUBLIC_BASE_URL}/api/auth/chzzk/callback`) |
| `CHZZK_DEFAULT_CHANNEL_ID` | - | 관리 화면에 기본으로 채워질 치지직 채널 ID |
| `SOOP_DEFAULT_CHANNEL_ID` | - | 관리 화면에 기본으로 채워질 SOOP 채널 ID |
| `CHAT_DATA_DIR` | - | 채팅 세션/프레임 캡처 저장 경로 (기본 `./data/chat-sessions`) |
| `FRAME_CAPTURE` | - | `0`으로 설정하면 프레임 캡처 기능을 완전히 끔 |

## 사용 방법

1. `pnpm dev` + `pnpm dev:client`로 서버/클라이언트를 띄운다.
2. 브라우저에서 Vite 클라이언트 URL의 `/admin`으로 접속한다.
3. 플랫폼(치지직/SOOP)과 채널 ID를 입력해 연결한다. 치지직은 공식 OAuth 인증 또는 비공식 웹소켓 중 선택할 수 있다.
4. 연결되면 대시보드에서 실시간 채팅량·참여율·하이라이트 후보를 확인할 수 있다.
5. 타임라인 막대에 마우스를 올리면 그 순간의 방송 화면 미리보기가, 클릭하면 선택 구간을 크게 자동재생하는 패널이 뜬다(ffmpeg 설치 시).
6. OBS에 채팅을 얹으려면 오버레이 URL을 브라우저 소스로 추가한다.

## 주요 API

| 엔드포인트 | 설명 |
|---|---|
| `POST /api/providers/:provider/connect` | 채팅 소스 연결 (provider: `chzzk`/`soop`) |
| `POST /api/providers/:provider/disconnect` | 채팅 소스 연결 해제 |
| `GET /api/analytics/live` | 실시간 분석 요약 |
| `GET /api/analytics/sessions` | 녹화된 세션 목록 |
| `GET /api/analytics/sessions/:sessionId/export` | 세션 데이터 내보내기 (CSV/JSON) |
| `GET /api/frames/chzzk/:second` | 특정 초의 캡처된 방송 프레임(JPEG) |
| `GET /api/auth/chzzk/start` | 치지직 OAuth 로그인 시작 |

## 테스트

```bash
pnpm test        # 유닛 테스트 (Vitest)
pnpm test:watch  # 워치 모드
pnpm test:e2e    # E2E 테스트 (Playwright)
pnpm typecheck   # 타입 체크만
```

## 프로젝트 구조

```
src/
├── client/              # React 대시보드 + 관리 화면 + 오버레이
│   ├── components/
│   └── hooks/
├── server/
│   ├── providers/        # 치지직(공식/비공식), SOOP 어댑터
│   ├── analytics.ts       # 증분 집계 엔진
│   ├── frameCapture.ts    # ffmpeg 프레임 캡처
│   ├── recorder.ts        # 세션 녹화(JSONL)
│   └── index.ts           # Fastify 서버 + API 라우트
└── shared/                # 클라이언트/서버 공용 타입
```

## 알려진 제한사항

- 프레임 캡처는 현재 치지직만 지원한다 (SOOP은 미지원).
- 서버 재시작 시 인메모리 분석 상태는 초기화된다 (세션 파일에서 복원하는 기능은 아직 없음).
- 비공식 웹소켓 어댑터는 각 플랫폼의 공개되지 않은 API에 의존하므로 플랫폼 쪽 변경에 취약할 수 있다.
