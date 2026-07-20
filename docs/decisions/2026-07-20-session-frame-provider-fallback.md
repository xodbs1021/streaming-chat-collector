# ADR-0003: 세션 탭 빈 구간 프레임 폴백 — 세션 provider 인지형 체인

**Date**: 2026-07-20
**Status**: accepted
**Deciders**: 김태윤(승인), Claude(분석·구현·검증)
**관련**: PR #42 · ADR-0002(대시보드 방송 뷰모델, PR #41)의 후속 — PR4 실측에서 발견된 기존 동작 교정

## Context

타임라인에서 구간을 고르면 "그 구간에 채팅이 어느 플랫폼에 더 많았나"(`dominantProvider`)로 어느 쪽 화면(프레임)을 보여줄지 정한다. 그런데 **채팅이 0개인 빈 구간은 판단 근거 자체가 없고**, 이때 소비처 3곳(Timeline 2, FramePlayerPanel 1)이 하드코딩 `?? "chzzk"`로 무조건 치지직으로 기울었다.

PR #41이 방송별 provider 탭을 도입하면서 이 기존 동작이 사용자 눈에 어긋남으로 드러났다: **SOOP 세션 탭을 보고 있는데 빈 구간을 고르면 치지직 프레임이 뜬다**(PR4 실측 발견). 세션 탭은 `sessionId = <broadcastId>__<provider>`로 단일 provider가 확정돼 있으므로, 근거 없는 구간의 정답은 자명히 "지금 보는 탭의 provider"다. 단, 라이브(병합) 뷰는 여러 provider가 섞이므로 기존 dominant→chzzk 동작이 맞다 — 이 비대칭을 어디서 어떻게 처리하느냐가 결정 지점.

## Decision

폴백 체인을 순수 함수 하나로 은닉한다:

1. **`resolvePrimaryProvider(counts, sessionProvider?)`** = `dominantProvider(counts) ?? sessionProvider ?? DEFAULT_PROVIDER("chzzk")` — 소비처 3곳이 이 한 이름을 호출. 채팅이 있으면 다수결(기존), 빈 구간이면 세션 provider, 그것도 없으면(=라이브) chzzk.
2. **`resolveSessionFallbackProvider(selectedSessionId, provider)`** — "라이브면 undefined" 불변식을 단독 소유하는 헬퍼(`LIVE_SESSION_ID` 상수). Dashboard는 이 결과를 `sessionProvider` prop으로 Timeline·FramePlayerPanel에 주입한다.
3. 적용 범위는 **라이브가 아닌 모든 세션 탭**(ended 한정 아님 — active 단일 provider 세션도 같은 버그). 경계 계약(`src/shared/types.ts`)은 무변경.

## Alternatives Considered

### 1. 세션 provider를 "우선"으로 (dominant보다 항상 앞세움)
- **Pros**: "세션 탭 = 그 provider"가 더 단정적
- **Cons**: 세션 윈도우는 그 세션(단일 provider) 채팅만 집계하므로, 채팅이 있는 구간에서 dominant는 이미 세션 provider와 같다 — 폴백과 결과가 전 구간 동일
- **Why not**: 구별되는 상황이 존재하지 않는 무의미한 분기(clarifier가 코드로 확정). 같은 결과라면 기존 로직을 덜 건드리는 폴백형이 최소 변경.

### 2. `dominantProvider` 내부에서 세션 폴백까지 처리
- **Pros**: 소비처 수정 최소화(함수 하나만 교체)
- **Cons**: "다수결"이라는 순수 계약이 화면 문맥(어느 탭인가)에 오염되고, 라이브/세션 구분이 함수 안으로 숨어 이름만 보고 동작을 알 수 없게 됨
- **Why not**: 이름=계약 원칙 위반. 다수결(`dominantProvider`)과 문맥 폴백(`resolvePrimaryProvider`)을 별개 이름으로 분리하고, 문맥은 소비처가 주입하는 편이 각 함수의 계약을 순수하게 유지한다.

### 3. Dashboard 인라인 삼항으로 라이브 가드 처리 (헬퍼 추출 없이)
- **Pros**: 파일 하나 덜 건드림
- **Cons**: tq 리뷰 HIGH — 이번 수정의 핵심 와이어링(라이브면 undefined)이 거대 컨테이너 안에 묻혀 어떤 테스트로도 고정되지 않음. 미래 리팩터링이 삼항을 지우면 라이브 병합 뷰가 조용히 깨짐(이번 버그의 거울상)
- **Why not**: 순수 헬퍼로 추출하면 live→undefined 불변식을 단위 테스트 3케이스로 저렴하게 고정할 수 있다. 추출 비용이 사실상 0.

### 4. ended 세션 탭에만 적용
- **Pros**: 원 증상("과거 방송")에 정확히 한정
- **Cons**: active 단일 provider 세션 탭도 동일 폴백 경로를 타므로 같은 어긋남이 남음
- **Why not**: 버그의 원인은 "세션 탭인데 세션 provider를 모른다"이지 ended 여부가 아니다. 라이브가 아닌 모든 세션 탭 적용이 원인 단위의 교정(브라우저 실측으로 양쪽 확인).

## Consequences

### Positive
- SOOP/치지직 세션 탭 어긋남 제거 — 하드코딩 chzzk 강제를 없앤 것 자체가 provider 대칭화
- 라이브(병합) 뷰는 `sessionProvider=undefined` 주입으로 기존과 바이트 동일 동작(검수로 확인) — 회귀 위험 격리
- 폴백 정책 전 분기가 순수 함수 단위 테스트(22케이스) + 소비처 RTL(2케이스, RED 검증)로 고정
- 서버·shared 무변경 → revert 1개로 완전 원복

### Negative
- `"live"` 센티넬 정의처 이원화 — 헬퍼는 `LIVE_SESSION_ID` 상수, Dashboard에는 raw `"live"` 리터럴 약 20곳 잔존(기존 스멜). 센티넬 변경 시 동기화 필요 → 상수를 export해 Dashboard까지 흡수하는 후속 정리 후보
- Timeline·FramePlayerPanel에 `sessionProvider?` prop 1개씩 표면 증가(문맥 주입 비용)
- `src/server/index.ts`의 `?? "chzzk"` 1건은 별개 도메인(방송 종료 로그 폴백)이라 의도적으로 범위 밖 — 프레임 경로와 무관

## 구현

`frameProviderSelection.ts`(함수 2·상수 2 추가) · `Timeline.tsx` · `FramePlayerPanel.tsx` · `Dashboard.tsx` + 테스트 2파일(단위 22 · RTL 2). typecheck·test 218·build 그린, 합성 SOOP 픽스처로 ended/active 세션 탭·라이브 뷰 브라우저 실측 완료. 머지 ≠ 운영 반영: `pnpm build` + 서버 재시작 필요.
