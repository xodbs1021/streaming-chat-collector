# CLAUDE.md

## 하네스: CHZZK/SOOP 채팅 시스템

**목표:** CHZZK/SOOP 채팅 수집·분석 시스템의 개발 요청을 질문정리→(구조적 변경 시 설계)→계획→계획검증→개발→검수→PR→PR점검→변경설명→완료감사 파이프라인으로 완결한다.

**제0원칙 (다른 모든 것에 우선):** 모든 개발은 `.claude/harness/principles.md`를 최우선으로 지킨다 — 코드는 사람을 위한 것, 이름=계약, 구현=교체 가능한 부품, 과설계 금지(YAGNI).

**트리거:** 코드 변경을 수반하는 작업(기능 추가/수정/버그수정/리팩터링, "개발/고쳐/만들어/추가/다시 해줘")을 요청받으면 `harness-orchestrator` 스킬을 사용하라. 단순 질문·설명·조회는 직접 응답 가능(변경 설명은 change-explainer, 설계 의도는 architecture-guide 직접 호출).

**도메인 슬롯:** 이 프로젝트의 스택·아키텍처 불변식·경계면·운영 모델·검증 명령·버전관리 정책(master 직접 커밋 금지 · squash merge · 스택 PR 금지 · 머지는 사용자 승인 후)은 `.claude/harness/project-profile.md`가 정본이다. 타입체크 명령의 기계 정본은 `.claude/harness/harness.env`.

**강제 훅 (`.claude/settings.json`, 커밋됨):** 기본 브랜치 직접 커밋 차단(PreToolUse) / 코드·설정 편집 시 `.needs-audit`·`.needs-explain` 플래그(PostToolUse — `_workspace/`·`.claude/`·`*.md`·프로젝트 밖 제외) / Stop 시 타입체크(harness.env)→change-explainer→completion-auditor 미이행이면 종료 차단(rc=2). 무한루프 가드 3회. 탈출구 `HARNESS_HOOKS=off`(전체) 또는 `ECC_DISABLED_HOOKS`에 `pre:bash:master-guard`·`post:edit:needs-audit`·`stop:verify`·`stop:explain`. 훅은 세션 시작 시 스냅샷 → 설치 세션에는 발화하지 않고 다음 세션부터 적용.

**using-superpowers 전역 선점 비활성:** 이 하네스는 `harness-orchestrator`가 스킬 순서를 통제한다. "응답 전 스킬 먼저"(using-superpowers) 전역 강제가 오케스트레이터 파이프라인을 가로채지 않게 한다. 각 에이전트는 자기 정의에 명시된 superpowers 스킬만 참조 호출한다.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-08 | 초기 구성 (7 에이전트 + 7 스킬 + 오케스트레이터) | 전체 | 사용자 요청 하네스 구축 |
| 2026-07-08 | plan-reviewer, completion-auditor 추가 (9 에이전트 + 9 스킬) | agents/, skills/, chat-harness | 계획 검증 루프 + 완료 주장 감사 게이트 요청 |
| 2026-07-08 | architecture-guide 추가 (10 에이전트 + 10 스킬) | agents/, skills/, chat-harness | "왜 이 구조로 짰나" 설계 의도 설명·교육 자문 에이전트 요청 |
| 2026-07-10 | 완료검증 훅 강제 (settings.json + hooks/ 4스크립트) | .claude/ | 감사자가 산문으로만 존재해 생략 가능 → Stop/PostToolUse/PreToolUse 훅으로 강제. 타입체크·감사 미실행 시 턴 종료 차단, master 커밋 차단 |
| 2026-07-12 | completion-auditor에 "운영 반영 여부" 감사 기준 추가 | agents/completion-auditor.md | 코드 완료(머지·테스트)만 검증하고 운영 서버(dist 빌드본) 반영을 안 봐서, 사용자가 옛 빌드 화면을 보며 "그대로"라고 항의한 실사고 재발 방지 |
| 2026-07-13 | change-explainer도 Stop 훅으로 강제(`.needs-explain` 플래그 + `stop:explain` 게이트, 순서 타입체크→설명→감사) | .claude/hooks/(_common·mark-needs-audit·verify-before-stop), CLAUDE.md | Phase 5(변경 설명)가 산문으로만 존재해 오케스트레이터가 임의로 건너뛴 실사고 발생 → completion-auditor와 동일한 플래그 게이트로 강제 |
| 2026-07-16 | 하네스 템플릿 마이그레이션: chat-harness+도메인 스킬 11개 → harness-orchestrator 1개, 에이전트 10→12(design-architect·security-reviewer 추가, 전원 제네릭화), 도메인은 프로필 슬롯으로, 훅 4종 신판(harness.env 기반 타입체크, HARNESS_HOOKS 탈출구) | .claude/ 전체, CLAUDE.md | 도메인-무관 재사용 템플릿(github.com/xodbs1021/kty-claude-harness-template)으로 일원화 — 정본 repo에서 sync.sh로 개선 전파 가능 |
| 2026-07-17 | find-skills 연동(sync) — 진화 신호 채택 시 자체 제작 전에 스킬 생태계 검색(`npx skills find`) 선행, 있으면 전역 설치 제안 | skills/harness-orchestrator | 만들기 전에 찾는다(재사용 우선) — 템플릿 faa8178 sync |
