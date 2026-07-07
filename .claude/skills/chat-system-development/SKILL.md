---
name: chat-system-development
description: CHZZK/SOOP 채팅 수집·분석 시스템(TypeScript/Fastify/socket.io/React19/Vite)을 실제로 구현·수정한다. developer 에이전트가 계획서를 받아 코드 작성·테스트 실행 시 사용. 새 기능 구현, 버그 수정, 리팩터링, "개발해줘/고쳐줘" 시 트리거.
---

# 채팅 시스템 개발

계획서를 받아 코드를 작성하고 테스트로 검증한다. 이 프로젝트의 아키텍처 규칙을 지키는 것이 핵심이다.

## 코딩 원칙

- **테스트 우선.** 순수 로직·유틸·데이터 변환은 Vitest 테스트를 먼저(또는 함께) 쓴다.
- **주변을 닮게.** 기존 파일의 네이밍·주석 밀도·관용구를 맞춘다.
- **불변성.** 제자리 변경 금지, 새 객체 생성(spread).
- **작게.** 함수 <50줄, 파일 <800줄, 중첩은 early return.
- **에러를 삼키지 않는다.** 외부 API 응답·사용자 입력·파일 내용은 경계에서 검증.

## 필수 아키텍처 규칙 (위반 시 검수 보류)

1. **실시간 vs 내구성 분리** — 인메모리 상태는 동기 즉시 갱신, 디스크 쓰기는 프로미스 체인 큐로 백그라운드 직렬화. 실시간 경로(소켓 emit로 이어지는 흐름)에 `await appendFile`/`mkdir` 두지 않기.
2. **증분 집계** — 메시지 유입 시 버킷·카운터 증분 갱신, 요약 시 dirty 윈도우만 재물질화. 매 주기 전체 복사·정렬·재토큰화 금지.
3. **경계면 shape 일치** — `src/shared/types.ts`의 공유 타입을 서버 응답·소켓 payload·React 소비가 함께 쓰게. 한 계층만 바꾸면 경계면 버그.
4. **provider 대칭** — chzzk 기능은 soop 필요성 판단. 공유 로직은 공유 모듈(`providers/reconnectBackoff.ts`, `shared/frameSeconds.ts` 등).
5. **장수 프로세스(ffmpeg)** — exit 이벤트만으로 상태 판단 금지("살아있지만 멈춘" 정체 감시 필요). 종료는 실제 exit 확인까지 await.
6. **지표 분자·분모 기간 일치** — 참여율처럼 비율 지표는 분자·분모의 관측 기간을 맞춘다.

## 주요 모듈 지도

- `src/server/index.ts` — Fastify + socket.io, API 라우트, provider connect/disconnect 오케스트레이션
- `src/server/analytics.ts` — 증분 집계 엔진(LiveAnalytics), 윈도우/하이라이트/참여율
- `src/server/providers/` — chzzkUnofficial/chzzkOfficial/soopUnofficial 어댑터, 정규화, 재연결 백오프
- `src/server/frameCapture.ts` — ffmpeg 프레임 캡처 매니저(provider별 HLS resolver 주입)
- `src/server/recorder.ts` — 세션 녹화(JSONL), 백그라운드 쓰기 큐
- `src/client/components/Dashboard.tsx` — 타임라인/프레임 미리보기/재생 패널
- `src/shared/types.ts` — 클라이언트/서버 공유 타입 (경계면의 단일 진실)

## GateGuard 대응

파일 수정/생성 전 fact 요구 훅이 뜨면 간결히 제시하고 재시도:
1. import/require하는 파일 2. 영향받는 공개 함수/클래스 3. (데이터 파일이면) 필드·구조 — 합성/redacted 값 4. 사용자 지시 원문.

## 검증 (끝내기 전 필수)

```
pnpm typecheck   # tsc --noEmit
pnpm test        # Vitest 전체
```
브라우저에서 관찰 가능한 변경이면 preview 도구로 실제 렌더링/동작을 확인한다. 타입·테스트 통과만으로 "됐다"고 하지 않는다 — 실제 동작 관찰까지가 완료다.

## 라이브 데이터 주의

`data/chat-sessions/` 아래 녹화 세션(JSONL)과 캡처 프레임(jpg)은 실데이터다. 검증용 파일을 이 디렉터리에 쓰지 말고, 덮어쓰기 전 대상을 먼저 확인한다. 개발 중 `tsx watch` 재시작은 인메모리 분석을 날리므로 라이브 검증 중 저장에 주의.
