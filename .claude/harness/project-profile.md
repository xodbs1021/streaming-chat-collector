# 프로젝트 프로필 — CHZZK/SOOP 채팅 시스템

> **이 파일은 하네스의 유일한 도메인 슬롯이다.** 제네릭 에이전트·오케스트레이터는 도메인 지식을 자기 안에 담지 않는다 — 오케스트레이터가 Phase 0에서 이 파일을 읽어 각 에이전트 프롬프트에 해당 §를 주입한다. 이 프로젝트가 바뀌면 여기만 고친다.

---

## 1. 정체성 (identity)

- **한 줄 정의:** CHZZK/SOOP 라이브 방송의 채팅을 실시간 수집·집계하고 화면을 프레임 캡처해 분석하는 시스템.
- **도메인:** 실시간 채팅 수집·분석 + 방송 화면 캡처.
- **주 사용자 & 기술 숙련도:** 본인 — 코딩 경험 적음. 전문용어는 풀어 설명하고 동작 관점으로 번역한다.
- **1차 언어(사용자 대면 보고):** 한국어.

---

## 2. 기술 스택 (stack)

- **언어:** TypeScript
- **프레임워크/런타임:** Fastify · socket.io · React 19 · Vite · Node · ffmpeg(자식 프로세스)
- **패키지 매니저:** pnpm
- **핵심 디렉토리 맵:**
  - `src/server/` — 수집·집계·프레임 캡처 서버(방송 세션 디렉토리, `broadcastPaths.ts`, `frameCapture.ts`, `analytics.ts`, `recorder.ts`, `providers/`)
  - `src/client/` — React 대시보드(`Dashboard.tsx`, 분석 훅)
  - `src/shared/types.ts` — 서버·클라 공유 타입(경계면 계약)
  - `tests/` — Vitest 유닛/경계면 테스트
  - `data/` — 방송 단위 세션 디렉토리(chat/frame × provider) — **실데이터, 검증용 파일 쓰기 금지**

---

## 3. 검증 명령 (verify)

> **타입체크 명령의 기계 정본은 `.claude/harness/harness.env`의 `HARNESS_TYPECHECK_CMD`다** — Stop 훅은 그 파일만 읽는다.
> 여기 §3에 명령을 다시 적지 마라(이중 기입 = 드리프트). 나머지 항목(테스트·빌드·린트·관찰)은 이 섹션이 정본.

- **타입체크:** `.claude/harness/harness.env` 참조 (여기 다시 적지 않는다)
- **테스트:** `pnpm test`  (Vitest)
- **빌드:** `pnpm build`
- **린트/포맷:** (프로젝트 설정 따름)
- **브라우저·런타임 관찰 필요?** 예 — 대시보드/캡처 변경은 preview 도구로 실제 렌더·네트워크·프레임 저장까지 관찰. 테스트·타입만으로 끝내지 않음.

---

## 4. 아키텍처 불변식 (invariants)

- **실시간 경로 vs 내구성 경로 분리** — 인메모리 상태(분석/시퀀스)는 동기 즉시 갱신, 디스크 쓰기는 프로미스 체인 큐로 백그라운드 직렬화. 실시간 경로에 `await appendFile`을 넣으면 채팅 폭주 시 그래프가 멈춘다.
- **증분 집계** — 매 주기 O(전체) 재계산 금지. 메시지 유입 시점에 버킷·카운터를 증분 갱신하고 dirty 윈도우만 재물질화. 안 지키면 데이터가 쌓일수록 느려지는 시한폭탄.
- **경계면 shape 일치** — 서버 API 응답 ↔ socket.io payload ↔ React 훅이 같은 타입(`src/shared/types.ts`)을 공유. 한쪽만 바꾸면 경계면 버그.
- **provider 대칭성(chzzk/soop)** — 한쪽에 넣은 기능은 다른 쪽 필요 여부를 판단. 재연결 백오프 같은 공통 로직은 공유 모듈로.
- **장수 자식 프로세스(ffmpeg)** — exit 이벤트만으로 상태 판단 금지("살아있지만 멈춘" 상태 감시 필요). 종료는 신호 전송이 아니라 실제 종료 확인까지.
- **핫 리로드 = 인메모리 데이터의 적** — `tsx watch`는 저장마다 재시작하며 인메모리 분석을 날린다. 라이브 데이터 검증 중 재시작 주의.

---

## 5. 경계면 맵 (boundaries)

- **서버 API 응답 ↔ socket.io payload ↔ React 훅/컴포넌트** — 공유 계약: `src/shared/types.ts`. reviewer는 서버 emit/응답과 이를 소비하는 훅을 **동시에 열어** shape을 교차 비교한다.

---

## 6. 배포·운영 모델 (ops)

- **운영 서버 실행:** `node dist-server/index.js` (포트 4010)
- **서빙 대상:** `dist/`·`dist-server/` **빌드본** — 소스가 아니라 빌드 산출물을 서빙.
- **소스→운영 반영 절차:** `pnpm build` + 서버 재시작. 머지만으로는 사용자 화면이 안 바뀐다.
- **"반영됨" 확인법:** `ls -lt dist/assets/` 빌드 시각이 머지 시각보다 최신인지. (2026-07-12 실사고: 사용자가 7/7 빌드본을 보며 "그대로"라고 항의 → 감사자가 "머지됨 — 단, 운영 미반영(빌드+재시작 필요)"을 명시하도록.)

---

## 7. 버전관리 정책 (vcs)

- **기본 브랜치:** master
- **브랜치 전략:** 기능마다 master에서 새 브랜치 → PR → squash merge. 스택 PR 금지(앞 PR 머지 시 base 삭제로 뒤 PR이 닫히는 실사고).
- **한 PR = 한 논리적 변경** — revert 하나로 롤백.
- **커밋/PR 제목:** Conventional Commits.
- **머지 주체:** 사용자 승인 후에만.
- **프로젝트 예외:** 없음.

---

## 8. 도메인 예시 (examples)

- "soop도 이미지 캡처되게 해줘" → chzzk만 되던 걸 soop로? 호버/클릭? 저장까지? — 범위·provider 대칭이 숨어 있음.
- "프레임 안 잡히는데 저장되는 거 맞아?" → 실시간 표시 문제인가 디스크 쓰기 문제인가, 경계가 숨어 있음.

---

## 9. 참고 — 전역 의존

- **ECC 룰:** `~/.claude/rules/ecc/`(web/typescript 룰셋).
- **superpowers:** developer→`test-driven-development`, completion-auditor→`verification-before-completion`, clarifier→`brainstorming`, planner→`writing-plans`, reviewer→`requesting-code-review`, 디버깅→`systematic-debugging`.
- **claude-mem:** 자동 캡처+검색(`claude-mem:mem-search`).
- **파일 메모리:** `~/.claude/projects/-Users-kty-Downloads-chat/memory/`(always-ask 규칙, 리팩터 로드맵, data 레이아웃 결정, SOLID 원칙, harness-template).
