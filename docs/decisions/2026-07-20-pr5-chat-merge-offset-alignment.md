# ADR-0004: 두 플랫폼 채팅 병합 — offset을 "볼 때 해석"이 아니라 "녹화 데이터 자체를 정렬"

**Date**: 2026-07-20
**Status**: accepted
**Deciders**: 김태윤(설계 제안·승인), Claude(추정기·정렬·배선·구현·검증)
**관련**: PR5(`claude/pr5-chat-merge-offset`) · ADR-0003(세션 프레임 폴백, PR #42)를 과거 뷰 프레임 소스 정책에서 부분 대체

## Context

동시송출 방송에서 치지직·SOOP 채팅을 한 타임라인으로 합쳐 보고 싶다(사용자 원 요구). 못 합치는 이유는 두 가지다.

1. **송출 딜레이가 플랫폼마다 다르고 방송 중에도 변한다**(드리프트).
2. **채팅 시각의 의미 자체가 다르다.** 탐색으로 확인: 치지직은 플랫폼 원본 이벤트 시각(`msgTime`)을 주지만, SOOP normalizer(`soopNormalizer.ts:71`)는 `Date.now()`(= 우리 서버 수신 시각)를 timestamp로 쓴다. 즉 SOOP 채팅은 이미 "서버가 받은 시각"이라 송출 딜레이만큼 늦게 찍힌다.

기존 라이브 "병합"은 이 어긋난 시각을 절대시간 버킷에 그냥 합산(단일 `LiveAnalytics`)했고, 과거 방송은 병합 열람 경로 자체가 없었다(세션 = provider별 `<broadcastId>__<provider>`).

### 설계가 뒤집힌 지점 (사용자 제안)

초기 설계는 **"볼 때마다 offset을 해석"**하는 방향이었다: 파일은 원본 그대로 두고, 열람 시 offset을 계산·적용해 클라이언트가 축을 변환(`chatAxis`/`candidateSecondsByProvider`/`frameProviderSelection` 시그니처 변경, 과거 방송 1회 계산 `ensure` 서비스). 이는 열람 경로마다 보정 장치를 이고 다녀야 하고, 화면·API·클라 세 곳에 축 변환이 번지는 구조였다.

사용자가 이를 뒤집었다: **"보정을 볼 때마다 하지 말고, 녹화 데이터 자체를 정렬해서 저장하라."** 그러면 과거 열람은 아무 보정 장치 없이 "그냥 합치기"가 된다. 이 한 문장이 아래 Decision 전체의 축이 됐다 — 열람 경로에서 offset 해석·축 변환 코드가 통째로 사라졌다.

## Decision

### 1. 부호 규약 (단일 진실원)

`src/shared/offset.ts` 한 파일에만 부호 민감 변환을 둔다.

```
anchorTime = soopTime + offsetMs
```

`offsetMs`는 SOOP(target) 시각을 치지직(anchor) 축으로 옮기는 이동량. **SOOP이 8초 늦으면 offsetMs = −8000.** 1호 회귀 테스트가 이 부호를 못 박는다.

### 2. anchor = 치지직

원본 이벤트 시각을 가진 쪽(치지직)을 기준 축으로 삼고, SOOP 시각을 그 축으로 이동한다.

### 3. 추정 = 채팅 봉우리 cross-correlation, 구간별 재추정

`offsetEstimator.ts`(순수): 1초 bin·구간 600초·탐색 ±60초·정규화 상관. 신뢰도 = 피크 강도 × runner-up 대비. 조용/저신뢰 구간은 직전 신뢰값 이어쓰기(`carried:true` = "추정치"), 선두는 첫 신뢰값 backfill, 신뢰 구간 0개면 `[]`. 파라미터는 전부 `EstimatorParams` 상수(실측 후 한 줄 변경).

### 4. 정렬 = 데이터 자체를 고친다 (핵심)

- **라이브** = 메모리 보정만. `LiveOffsetTracker.observe`(O(1)) → 60초 주기 `reestimate` → `LiveAnalytics.retimeProvider`로 과거 append분 재배치(웜업 종료 1회 + |delta|>2초). **디스크 기록은 원본 그대로.**
- **finalize(방송 종료)** = 방송 전체 채팅으로 최종 offset 계산 → SOOP `chat.jsonl`의 timestamp를 anchor 축으로 **일괄 재작성**(라인 순서·sequence·`receivedAt` 보존, timestamp만) → `<broadcastId>/offset.json` 마커. **마커 존재 = 정렬됨**(멱등 가드). 임시 파일→rename 원자 교체.
- **과거 열람** = 정렬된 파일을 **단순 concat**(`/api/broadcasts/:id/windows`). 축 변환 없음.

### 5. UI

과거 방송 탭 [합쳐 보기 | 치지직 | SOOP], 기본 = 합쳐 보기(형제 ≥2). 탭은 채팅+그래프만 전환한다. **프레임(이미지)은 탭과 무관하게 기준 소스 고정(치지직, 없으면 SOOP)** — `framePrimaryProvider` 오버라이드. 싱크 배지(`offset:live`/`offset.json`)로 현재 보정값·추정 구간 수를 노출한다. 활성(녹화 중) 방송의 병합 탭은 파일이 아직 미정렬이라 차트를 그리지 않고 "방송 진행 중 — 종료 후 정렬"을 표시한다.

### 6. 킬스위치

`OFFSET_SYNC=0`이면 라이브 무보정·finalize 재작성 생략(현행 동작 복귀). `CAPTURE_SYNC` 선례 미러.

## Alternatives Considered

### 1. 열람 시 offset 해석 + 클라 축 변환 (초기 설계)
- **Pros**: 파일 불변 — 원본 보존, 정렬 로직 변경이 파일에 남지 않음
- **Cons**: 열람 경로마다 offset 계산·적용·축 변환을 이고 다녀야 함(`chatAxis`/`candidateSecondsByProvider`, frameProviderSelection 시그니처 변경, 과거 1회 계산 서비스). 화면·API·클라 세 곳에 축 변환 번짐
- **Why not**: 사용자 제안으로 폐기. "데이터 자체 정렬"이 열람 경로를 무보정 단순 concat으로 만들어 총 복잡도가 훨씬 낮다. 원본 시각 손실은 `receivedAt`(원본 수신 시각)이 보존하므로 필요 시 복원 가능

### 2. 프레임 이미지 비교로 정렬
- **Pros**: 채팅이 조용한 구간도 화면으로 정렬 가능
- **Cons**: ffmpeg 프레임 디코드·비교 비용, 캡처 공백 구간 취약
- **Why not**: 사용자 판정 — 하이라이트가 채팅 기반이라 봉우리 정밀도로 충분. "프레임 정밀 보정 후속"을 폐기

### 3. `viewers.jsonl`도 anchor 축으로 재작성
- **Pros**: 시청자 추이도 채팅과 같은 축
- **Cons**: 원본 수신 시각 보존 필드가 없어 **비가역**. 게다가 양 provider 시청자 샘플은 이미 서버 수신 시각이라 서로 축이 일치하고, offset(초)이 샘플 granularity보다 작아 무해
- **Why not**: 되돌릴 수 없는 파괴적 변경인데 이득이 없음. chat.jsonl만 재작성(롤백 문구도 chat 한정)

### 4. FFT 상관
- **Pros**: 큰 창에서 이론상 빠름
- **Cons**: 구간당 곱셈 ~7만 회(600 bin × 121 lag)로 직접 상관이 이미 충분히 싸다
- **Why not**: YAGNI — 의존성·복잡도만 늘고 실측 규모에서 이득 없음

### 5. 과거 뷰 프레임을 탭 provider 따라 (ADR-0003 유지)
- **Pros**: SOOP 탭 = SOOP 프레임, 직관적
- **Cons**: 동시송출은 화면이 사실상 같고, 후속 PR6에서 프레임 수집을 치지직 1곳으로 단일화할 예정 — 프레임은 개념상 한 소스
- **Why not**: 사용자 결정 #4("프레임은 탭과 무관하게 기준 소스 고정"). 과거 뷰 프레임을 anchor(치지직)로 고정하고 SOOP 폴백. ADR-0003의 `sessionProvider` 폴백 메커니즘은 **라이브 경로에 그대로 남지만**, 과거 뷰의 기본 프레임 소스는 `framePrimaryProvider`가 덮는다(수동 탭으로 SOOP 프레임은 여전히 볼 수 있음)

## Consequences

### Positive
- 과거 열람이 무보정 단순 concat — 열람 경로에서 offset 해석·축 변환 코드가 통째로 사라짐(사용자 제안의 핵심 이득)
- 부호 규약이 `shared/offset.ts` 한 파일 + 1호 회귀 테스트로 고정 — 부호 뒤집힘 회귀를 저비용으로 방지
- 실시간 경로 불변식 준수: `observe`는 O(1), 무거운 상관은 60초 타이머만
- `offset.json` 마커로 멱등·자기 치유(마커 없음 = 미보정 = 구버전과 동일 취급)
- `OFFSET_SYNC=0` 즉시 현행 동작 복귀. chat.jsonl은 `receivedAt`으로 원복 가능
- 경계면(`shared/types.ts`): `LiveOffsetStatus`(라이브 배지)를 내구 모델 `BroadcastOffset`과 분리해 시그니처 고정

### Negative
- **PR5 이전 녹화는 미보정으로 남는다**(finalize를 안 탔으므로 마커 없음). 사용자 판정: 어차피 폐기 예정 데이터라 무방
- 크래시로 finalize를 못 탄 방송은 미정렬(마커 없음). rewrite→marker 사이 짧은 창에서 크래시 시 이론상 이중 적용 위험이 있으나, 마커를 rewrite 성공 뒤에 원자 교체로 써서 창을 최소화(플랜 수용 설계)
- **ADR-0003 대비 과거 뷰 프레임 기본 동작 변경**: SOOP 세션 탭도 기본 프레임이 치지직(수동 탭으로 SOOP 가능). ADR-0003의 컴포넌트 폴백 계약은 유지되나 Dashboard 배선이 과거 뷰에 `framePrimaryProvider`를 얹음
- SOOP 세션 export의 relative 시각(`analytics.ts:322`, `timestamp − startedAt`)은 재작성 후 offset만큼 이동한다(음수는 기존 가드가 드랍). 기존 export shape은 무변경 — "SOOP export 시각은 anchor 축"이 이 PR의 계약
- 병합 탭은 이번 PR 읽기 전용(마커는 치지직 세션 것 표시, 메모·마커 쓰기·window-compare는 provider 저장소에 묶여 범위 밖)

### 알려진 한계 (4중 검수에서 수용·기각 — 의도적 미수정)
- **희박 버스트가 600초 구간 경계에 걸치면 그 증거를 버릴 수 있다.** 600초 구간에선 드물고 carry 안전망(직전 신뢰값 이어쓰기)이 받쳐 무해 판정. 정밀 경계 처리는 YAGNI.
- **저널/fsync 트랜잭션은 도입하지 않는다.** 로컬 단일 사용자 도구에 과설계 — rewrite→marker 크래시 창은 위 Negative대로 수용하고, 대신 "마커는 재작성 이후에 쓰인다 + 재실행 이중 시프트 없음"을 회귀 테스트로 고정(재실행 시 이미 정렬된 파일 재추정 ≈0).
- **finalize 직후 라이브 뷰 자동 갱신은 하지 않는다.** 방송 종료 직후의 전이 상태라 수용(다음 조회/재선택에서 정렬본이 로드됨).
- **활성 방송 병합 탭 fetch-skip은 컨테이너(Dashboard) 렌더 테스트로는 고정하지 않았다.** 이 저장소에 Dashboard 렌더 테스트 하네스가 없고(소켓·fetch 모킹 비용·플레이키), 동작은 `mergedOffsetBadge(활성→"방송 진행 중")` 단위 테스트 + 브라우저 실측으로 확인한다.

## 구현

`shared/offset.ts`·`shared/types.ts`(offset 타입 4 + `offset:live`) · `server/offset/`(offsetEstimator·finalizeAlignment·liveOffsetTracker·offsetMarker) · `server/routes/broadcasts.ts`(병합 API) · `server/index.ts`(트래커 배선·60초 타이머·finalize·킬스위치) · 클라(`viewSelection`·`BroadcastTabs` 합쳐 보기 탭·`OffsetBadge`·`Timeline`/`FramePlayerPanel` `framePrimaryProvider`). 초기 8커밋(TDD) + 4중 검수(cc·cx·tq·보안) 후 3 fix 커밋(스프레드 오버플로·구간 축 고정점·라이브 applied 축·recorder 레이스). typecheck·test 그린. 후속 PR6: 프레임 수집 단일화(치지직만, 폴백 SOOP).

**머지 ≠ 운영 반영**: `pnpm build` + 서버 재시작 필요(dist 빌드본 서빙).
