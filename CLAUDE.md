# CLAUDE.md

## 하네스: 채팅 시스템 개발 파이프라인

**목표:** CHZZK/SOOP 채팅 수집·분석 시스템의 개발 요청을 질문정리→계획→개발→검수→PR→PR점검→변경설명 파이프라인으로 완결한다.

**트리거:** 코드 변경을 수반하는 작업(기능 추가/수정/버그수정/리팩터링, "개발/고쳐/만들어/추가/다시 해줘")을 요청받으면 `chat-harness` 스킬을 사용하라. 단순 질문·설명·조회는 직접 응답 가능.

**버전관리 정책 (확정):** master 직접 커밋 금지. 기능마다 master에서 새 브랜치 → PR → **squash merge**. 스택 PR 금지(앞 PR 머지 시 base 삭제로 뒤 PR이 닫히는 사고 있었음). 한 PR = 한 논리적 변경 = revert 하나로 롤백. 머지는 사용자 승인 후에만.

**훅 강제 (`.claude/settings.json`, 커밋됨):** 정책·완료검증을 산문이 아니라 훅으로 강제한다. 스크립트는 `.claude/hooks/`.
- `PreToolUse(Bash)` → **master 직접 `git commit` 차단.** (`gh pr merge`는 차단 안 함 — 훅은 "사용자 승인"과 "모델 독단"을 구분 못 함.)
- `PostToolUse(Edit|Write)` → 코드/설정 편집 시 `.claude/.needs-audit`·`.claude/.needs-explain` 두 플래그 생성(`_workspace/`·`.claude/`·`*.md` 제외).
- `Stop` → 플래그가 있으면 **타입체크 실패, change-explainer 미실행, 또는 completion-auditor 미실행 상태로 턴 종료를 차단**(rc=2). 게이트 순서는 타입체크 → change-explainer(Phase 5) → completion-auditor(Phase 6). 각 에이전트가 실제로 돈 뒤 해당 플래그(`.needs-explain`/`.needs-audit`)를 지워야 종료 가능. `chat-harness` Phase 5·6이 이 훅으로 강제된다.
- **무한루프 가드:** Stop 차단은 한 턴에 최대 3회(`.claude/.stop-block-count`), 소진 시 경고 후 두 플래그 모두 지우고 통과(세션 벽돌 방지).
- **탈출구:** `CHAT_HOOKS=off`(전체) 또는 `ECC_DISABLED_HOOKS`에 `pre:bash:master-guard`·`post:edit:needs-audit`·`stop:verify`(완료 게이트 전체)·`stop:explain`(변경 설명 게이트만) 나열.
- 훅은 세션 시작 시 스냅샷된다 → **설치 세션에는 발화하지 않고 다음 세션부터 적용.**

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-08 | 초기 구성 (7 에이전트 + 7 스킬 + 오케스트레이터) | 전체 | 사용자 요청 하네스 구축 |
| 2026-07-08 | plan-reviewer, completion-auditor 추가 (9 에이전트 + 9 스킬) | agents/, skills/, chat-harness | 계획 검증 루프 + 완료 주장 감사 게이트 요청 |
| 2026-07-08 | architecture-guide 추가 (10 에이전트 + 10 스킬) | agents/, skills/, chat-harness | "왜 이 구조로 짰나" 설계 의도 설명·교육 자문 에이전트 요청 |
| 2026-07-10 | 완료검증 훅 강제 (settings.json + hooks/ 4스크립트) | .claude/ | 감사자가 산문으로만 존재해 생략 가능 → Stop/PostToolUse/PreToolUse 훅으로 강제. 타입체크·감사 미실행 시 턴 종료 차단, master 커밋 차단 |
| 2026-07-12 | completion-auditor에 "운영 반영 여부" 감사 기준 추가 | agents/completion-auditor.md | 코드 완료(머지·테스트)만 검증하고 운영 서버(dist 빌드본) 반영을 안 봐서, 사용자가 옛 빌드 화면을 보며 "그대로"라고 항의한 실사고 재발 방지 |
| 2026-07-13 | change-explainer도 Stop 훅으로 강제(`.needs-explain` 플래그 + `stop:explain` 게이트, 순서 타입체크→설명→감사) | .claude/hooks/(_common·mark-needs-audit·verify-before-stop), CLAUDE.md | Phase 5(변경 설명)가 산문으로만 존재해 오케스트레이터가 임의로 건너뛴 실사고 발생 → completion-auditor와 동일한 플래그 게이트로 강제 |
