# ADR-0002: 대시보드 방송 뷰모델 — 세션=방송 그룹핑 + provider 탭 + 녹화 컨트롤

**Date**: 2026-07-20
**Status**: accepted
**Deciders**: 김태윤(UX·경계 결정), Claude(설계·구현·검증)
**관련**: data-layout-restructure 리팩터 4PR 계획의 PR4(마지막) · PR1(방송 라이프사이클) · PR2(프레임 세션화) · PR3(과거 프레임 API, #33)

## Context

PR1~PR3이 서버·shared에 "방송(broadcast) 단위" 내구 모델(`BroadcastSession`, `broadcastId`, 세션화된 프레임)을 세웠지만, 대시보드는 여전히 평면 `RecordingSession[]`을 그대로 나열했다. 한 방송의 CHZZK·SOOP 세션이 사이드바에 별개 행으로 흩어져 "같은 방송"이라는 사실이 화면에 드러나지 않았다.

또한 PR1 리뷰에서 HIGH로 지적된 간극이 남아 있었다: 클라이언트에서 `recording:start`/`recording:stop`을 쏘는 UI가 아예 없어, 대시보드만 보고는 녹화를 시작할 방법이 없었다.

이 PR은 그 두 간극을 화면 계층에서만 메운다. 서버 계약을 건드리지 않고 기존 방출 이벤트·기존 세션 조회 API 위에 뷰를 얹는 것이 제약이었다(한 PR=한 논리적 변경, 서버·shared diff 0 목표).

## Decision

대시보드 뷰 계층에만 다음을 추가한다:

1. **방송 그룹핑 뷰모델** `broadcastGroups.ts` — 평면 세션 목록을 `broadcastId ?? sessionId`로 묶어 `BroadcastGroup[]`로 변환(사이드바 1행 + provider 배지).
2. **과거 방송 provider 탭** `BroadcastTabs` — 선택된 방송의 형제 세션 간 전환. **탭 상태축을 새로 만들지 않고 기존 `selectedSessionId`를 재사용**한다.
3. **녹화 시작/종료 컨트롤** `RecordingControls` — status-strip에 상시 노출. 연결 provider 수를 서버 술어와 동일하게 판정하는 `providerConnection.ts`로 활성/비활성을 가른다.

## Alternatives Considered

### 1. 탭 상태를 `selectedProvider` 별도 state로 두기
- **Pros**: "지금 어느 provider 탭인가"가 이름으로 명시적
- **Cons**: 진실의 원천이 둘(`selectedSessionId` + `selectedProvider`) → 동기화 부담, 하류 분석/프레임 effect가 이미 `selectedSessionId`에 매여 있어 재배선 필요
- **Why not**: 탭 전환의 본질은 "어느 세션을 보나"이고 그건 이미 `selectedSessionId` 하나로 표현된다. 형제 세션 중 하나를 고르는 것이므로 새 축이 불필요(YAGNI). 이 선택 덕에 하류 분석·프레임 effect가 **전부 무변경**으로 그룹핑/탭을 얻었다.

### 2. 탭·선택을 URL 상태로 (쿼리 파라미터)
- **Pros**: 공유 가능한 딥링크, 새로고침 보존
- **Cons**: 현 대시보드에 라우팅/URL-상태 관례가 전혀 없다 → 라우터 도입은 이 PR 범위 밖의 별개 논리 변경(한 PR=한 변경 위반)
- **Why not**: 공유 요구가 실재하지 않는데 인프라부터 까는 과설계. 필요가 실제로 생기면 그때 별 PR로.

### 3. `BroadcastGroup`을 shared 타입으로 승격
- **Pros**: 서버·클라 한 정의 공유
- **Cons**: 서버는 이 shape을 방출도 소비도 하지 않는다 → shared에 올리면 아무도 안 쓰는 계약이 경계면에 늘어남. shared `BroadcastSession`(내구 모델)과 관심사가 다른데 섞이면 "무엇이 계약이고 무엇이 뷰인가"가 흐려짐
- **Why not**: `BroadcastGroup`은 순수 클라 전용 뷰모델이다. 경계면은 넘지 않는 것을 넘지 않게 두는 편이 계약 표면을 최소로 유지한다.

### 4. 클릭 분기 테스트를 생략(계획의 "RTL 미도입" 전제 유지)
- **Pros**: 컴포넌트 테스트 인프라 도입 비용 회피
- **Cons**: tq 리뷰가 HIGH로 지적 — 녹화 버튼 3상태·탭 클릭 분기가 순수 함수 밖이라 유닛으로 안 잡힘
- **Why not**: 검증 중 RTL·jsdom이 **이미 설치·배선됨**을 확인(도입 비용 실질 0). 전제가 틀렸으므로 `.test.tsx` 3파일을 도입해 HIGH를 해소했다. 프로젝트 최초의 컴포넌트 테스트.

## Consequences

### Positive
- 한 방송의 CHZZK·SOOP가 사이드바 1행으로 묶여 "같은 방송"이 화면에 드러남
- 대시보드에서 녹화를 시작/종료할 수 있게 됨(PR1 리뷰 HIGH 해소)
- `selectedSessionId` 재사용으로 하류 분석·프레임 effect **전부 무변경** — 변경 표면 최소
- **서버·shared diff 0** → revert 1개로 완전 원복(뷰 계층만)
- `countConnectedProviders`가 서버 `connectedProviderRefs`(`index.ts:288`)의 술어(`connected || reconnecting`)를 미러 → 순수 함수 + 테스트로 경계 드리프트 고정. 두 술어가 갈리면 "버튼은 눌리는데 서버가 무시"하는 괴리가 나는데 이 테스트가 그걸 붙잡음
- 컴포넌트 테스트 인프라(RTL·jsdom)가 실사용으로 진입 — 이후 클릭 분기 테스트의 발판

### Negative
- `BroadcastGroup`(클라 뷰) ↔ `BroadcastSession`(shared 내구) 두 방송 개념이 공존 → JSDoc으로 관심사 경계를 명시(서버 미방출/미소비)해 혼동 방지
- `connectedCount` 술어가 서버 상수의 **미러**라 서버가 술어를 바꾸면 수동 동기화 필요 → 테스트가 드리프트를 드러내도록 고정(자동 동기는 shared 승격을 요구하는데 그건 대안 3에서 기각)
- 머지 ≠ 운영 반영: 이 변경은 클라 번들이므로 `pnpm build` + 서버 재시작해야 실제 화면에 반영됨

## 구현

신규: `broadcastGroups.ts`(순수 유틸) · `BroadcastTabs` · `RecordingControls` · `providerConnection.ts` + 테스트 5파일(broadcastGroups 15 · recordingLabel 4 · RecordingControls 4 · BroadcastTabs 5 · providerConnection 4). 수정: `Dashboard.tsx` · `SessionSidebar.tsx` · `format.ts` · `frameProviderSelection.ts`(export 1줄) · `styles.css`. 서버·`src/shared` 변경 0. 유닛/컴포넌트 241 그린, typecheck·build 그린.
