---
name: chat-system-pr-review
description: 올라온 GitHub PR을 점검한다. base 브랜치·파일 범위·diff 완결성·정책 준수·코드 정합성을 확인하고 승인/변경요청을 판정. pr-reviewer 에이전트가 PR 생성 직후 사용. "PR 점검/리뷰해줘", PR이 올라온 직후 트리거.
---

# 채팅 시스템 PR 점검

`pr-author`가 올린 PR을 병합 전에 점검한다. 로컬 코드 검수(reviewer)와 달리, **PR 단위 자체**의 위생과 정책 준수를 본다.

## 점검 항목

### 1. PR 위생
- **base가 master인가** — 스택 PR로 잘못 겨냥하지 않았는가.
- **파일 범위** — diff에 이 기능 파일만 있는가. 무관한 변경·디버그 코드·임시 파일·실데이터가 섞이지 않았는가. (`gh pr view <n> --json files`)
- **최신성** — 브랜치가 최신 master에서 출발했는가. 뒤처져 충돌 위험은 없는가.
- **제목·본문** — Conventional Commits 제목, 테스트 플랜 포함.

### 2. 변경 완결성
diff만으로 self-contained인가. 참조하는 함수·타입이 같은 PR에 있거나 이미 master에 있는가. (빠진 파일로 인해 머지 후 빌드 깨짐 방지)

### 3. 코드 정합성 재확인
`gh pr diff <n>`로 전체를 읽고, 로컬 reviewer가 놓쳤을 경계면·엣지 케이스를 다시 본다. 특히 서버 응답 shape ↔ 클라이언트 소비.

### 4. 테스트/CI
주장된 테스트가 실제 통과하는지 확인 가능하면 확인(`gh pr checks <n>` 또는 로컬 체크아웃 후 `pnpm test`).

### 5. 롤백성
squash 후 이 커밋 하나 revert로 깔끔히 되돌아가는가, 다른 변경과 얽혔는가.

## 판정

```
판정: 승인 | 변경요청
차단(블로킹): [머지 전 반드시 수정 — 파일:라인 + 이유]
비블로킹: [개선 제안]
```
변경요청이면 → `pr-author`(PR 위생) 또는 `developer`(코드). 승인이면 → `change-explainer`.

## 상태 이상 대응

`gh` 실패, PR이 CLOSED, mergeable이 UNKNOWN 등 예상 밖 상태면 원인을 확인해 보고한다. UNKNOWN은 GitHub가 머지 가능성 계산 중일 수 있으니 잠시 후 재확인. 과거에 base 브랜치 삭제로 PR이 자동 CLOSED된 사례가 있으니, 스택 관계·base 존재 여부를 함께 본다.

## 머지하지 않는다

이 스킬은 판정만 한다. 실제 머지는 사용자 승인 하에 오케스트레이터/pr-author가 수행.
