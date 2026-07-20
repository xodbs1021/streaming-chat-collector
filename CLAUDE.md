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
| 2026-07-17 | superpowers 갭 보정(developer: systematic-debugging·receiving-code-review) + Codex 듀얼 리뷰([cc]/[cx] 태그, 없으면 명시적 생략) + PR 본문 5섹션 필수(What/Why/Design/Test/Rollback, pr-reviewer 점검) | agents/(developer·pr-author·pr-reviewer), skills/harness-orchestrator | 정기 점검에서 원 스펙 미배선 발견 + 사용자 요청(codex 병렬 리뷰·PR 규격) — 템플릿 bf23611 sync |
| 2026-07-18 | 테스트 품질 리뷰 조건부 배선 — `ecc:pr-test-analyzer` 참조 dispatch(`[tq]` 태그, 행동 커버리지 관점). 테스트 생성 에이전트 분리는 TDD 구조 충돌로 기각 | skills/harness-orchestrator | 테스트 리뷰 관심사 분리 요청 — 신규 제작 대신 기존 ECC 재사용(만들기 전에 찾는다) — 템플릿 5313b8b sync |
| 2026-07-18 | 메모리 계층 규약 — `_workspace/progress.md`(RAM: Phase 전환마다 갱신·완료 시 아카이브·캐시에 진행 로그 금지) + `docs/decisions/` ADR(중요 결정을 같은 PR에 영구 큐레이션, ecc:architecture-decision-records 참조). 기록 전담 에이전트 신설은 claude-mem 중복으로 기각 | skills/harness-orchestrator | 캐시(파일 메모리)=규칙 / RAM(progress)=진행 / SSD(claude-mem)=전량 이력 — 사용자 설계 계층 완성 — 템플릿 dc7927d sync |
| 2026-07-18 | ADR 규약 구조화 — 결정 시점 기록 원칙, 트리거 3종, Nygard 형식(Context/Decision/Alternatives/Consequences), 작성 주체(파이프라인 안=pr-author 같은 PR·밖=메인 세션 docs-only PR) + ADR-0001(메모리 3계층) 작성 | skills/harness-orchestrator, docs/decisions/ | claude-mem 사후 추출은 압축 손실·토큰 비용 — 결정 시점 기록으로 사고 과정 원형 보존(블로그·포트폴리오) — 템플릿 4d16493 sync |
| 2026-07-20 | 역할 등가 4종을 ECC 참조로 교체 — planner→`ecc:planner`·design-architect→`ecc:architect`·reviewer→`ecc:code-reviewer`·security-reviewer→`ecc:security-reviewer` (자체 에이전트 12→8). 하네스 계약(판정 형식·카테고리 태그·프로필 준수·수정 금지)은 오케스트레이터 "dispatch 계약" 신설로 프롬프트 주입 | .claude/agents/, skills/harness-orchestrator | 자체 제작 에이전트의 생태계 대체 전수 조사(사용자 지시) — 역할 등가는 ECC 참조로, 생태계에 없는 게이트·감사류만 자체 소유(만들기 전에 찾는다를 자신에게도 적용) — 템플릿 c3bcbaa sync |
