---
name: harness-orchestrator
description: 이 프로젝트의 개발 작업 전체를 조율하는 오케스트레이터. 질문정리→계획→계획검증→개발→검수→PR→PR점검→변경설명→완료감사 파이프라인을 에이전트 팀으로 실행한다. 기능 추가/수정/버그수정/리팩터링 등 코드 변경을 수반하는 모든 작업 요청 시 반드시 사용. "개발해줘", "기능 추가", "고쳐줘", "만들어줘", "구현해줘", "계획 세워줘", "검수해줘", "점검해줘", "PR 올려줘/만들어줘", "다시 해줘", "재실행", "보완", "수정해줘", "이전 결과 기반으로" 시 트리거. 단순 질문·설명·조회는 직접 응답 가능(변경 설명은 change-explainer, 설계 의도는 architecture-guide 직접 호출).
---

# 하네스 오케스트레이터 (도메인-무관)

전문 에이전트들을 파이프라인 + 3중 생성-검증 루프(계획·개발·PR)로 조율해, 사용자의 개발 요청을 계획부터 PR·설명·완료감사까지 완결한다. 도메인 지식은 이 스킬에 없다 — 전부 `.claude/harness/project-profile.md`(프로필)에서 온다.

**실행 모드: 에이전트 팀.** 개발↔검수, PR작성↔PR점검 사이의 피드백 루프가 있어 팀 통신이 유리하다. 모든 Agent 호출에 `model: "opus"`를 명시한다.

**스킬 통제권:** 전역 using-superpowers의 "응답 전 스킬 먼저" 선점은 이 하네스에서 비활성(CLAUDE.md 지시). 어떤 superpowers 스킬을 언제 쓰는지는 각 에이전트 정의와 이 오케스트레이터가 결정한다.

## Phase 0: 컨텍스트 확인 + 도메인 로드

1. **실행 모드 판별:**
   - `_workspace/` 존재 + 부분 수정 요청("검수만 다시", "PR만") → **부분 재실행** (해당 에이전트만, 아래 해당 Phase로 점프)
   - `_workspace/` 존재 + 새 입력 → **새 실행** (기존을 `_workspace_prev/`로 이동)
   - `_workspace/` 미존재 → **초기 실행**
2. **프로필·원칙 로드(오케스트레이터가 직접 1회 Read):** `.claude/harness/project-profile.md` + `.claude/harness/principles.md`. 이후 각 에이전트 dispatch 시 아래 주입 규칙대로 **해당 섹션 전문을 Task 프롬프트에 동봉**한다 — 에이전트가 "읽으러 갈지"를 선택에 맡기지 않는다.
3. **과거 기억 검색(초기 실행 시 1회):** `claude-mem:mem-search` 스킬을 호출해 "전에 이 문제/유사 요청을 풀었나"를 검색(search→timeline→get_observations 3층 워크플로우). 관련 결과가 있으면 clarifier·planner 프롬프트에 요약 동봉. (claude-mem은 2세션째부터 자동 주입도 하므로, 명시 검색은 착수 시 1회면 충분.) 검색 결과에 하중지지 사실(확정 결정·규칙)이 있으면 파일 메모리로 승격을 제안한다.

### 프로필 주입 규칙 (에이전트 → 동봉 섹션)

| 에이전트 | 주입할 프로필 섹션 | 추가 동봉 |
|---|---|---|
| clarifier | §1 정체성 · §8 도메인 예시 | mem-search 결과 |
| design-architect | §2 · §4 · §5 | principles.md · mem-search 결과 |
| planner | §2 스택 · §4 불변식 · §5 경계면 · §7 vcs | principles.md · mem-search 결과 · (구조적이면) 설계서 경로 |
| plan-reviewer | §4 · §5 · §7 | principles.md |
| developer | §2 · §3 검증 · §4 · §5 | principles.md · 계획서 경로 · harness.env(타입체크 정본) |
| reviewer | §3 · §4 · §5 | principles.md · harness.env |
| security-reviewer | §4 · §5 | 변경 파일 목록 |
| pr-author | §3 (테스트 플랜용) · §7 | — |
| pr-reviewer | §5 · §7 | — |
| change-explainer | §1 (언어·톤) · §6 운영 | PR URL |
| completion-auditor | §3 · §6 | 완료 주장 목록 · harness.env |

## Phase 1: 명료화 게이트 (clarifier)

**항상 먼저** `clarifier`로 요청의 모호점·비가역 작업·숨은 가정을 점검한다.
- 판정 "확인 필요" → 정리된 질문을 **AskUserQuestion으로 사용자에게 직접** 묻는다(clarifier는 질문을 만들 뿐, 실제 묻기는 오케스트레이터가). 답을 받고 진행.
- 판정 "명확" → Phase 2로.

> 이 게이트가 이 하네스의 1번 가치다. "확실하지 않으면 추측 말고 물어본다"를 파이프라인이 강제한다.

## Phase 2: 설계·계획↔검증 루프 (design-architect → planner ⇄ plan-reviewer)

**구조적 변경 판별(오케스트레이터):** 새 모듈/레이어 신설 · 기존 경계나 데이터모델 변경 · 3개 이상 모듈 영향 중 하나라도 해당하면 "구조적".

**구조적 변경이면 (2-pass):**
1. `design-architect`가 설계서(`_workspace/00_design.md`) 작성 — 모듈 경계·계약·패턴·대안 트레이드오프.
2. `plan-reviewer` **1차 pass(설계만)**: 제0원칙·계약 명시성·불변식 충돌·과설계를 검증. 보류면 design-architect로 루프.
3. `planner`가 설계서를 입력으로 구현 계획서(`_workspace/01_plan.md`) 작성.
4. `plan-reviewer` **2차 pass(계획+정합성)**: 기존 점검 전체 + 설계↔계획 정합성. 보류면 planner로 루프.

**비구조적이면 (기존 흐름):**
1. `planner`로 구현 계획서를 만든다. 영향 범위·모듈 경계(제0원칙)·PR 단위 단계·리스크·테스트 계획. `_workspace/01_plan.md`에 저장.
2. `plan-reviewer`가 완결성·영향범위 정확성·PR 단위·리스크 누락·테스트 구체성·아키텍처 정합(§4)·제0원칙을 검증.
3. 보류(차단)면 planner로 되돌려 수정 → 재검증. **승인까지 루프.**

> 계획에도 generate-verify를 두는 이유: 결함은 늦게 잡을수록 비싸다. 가장 싼 지점(구조적이면 설계 직후)에서 결함을 잡는다. plan-reviewer는 pass마다 새 컨텍스트로 단일 임무만 받으므로 혼란이 없다.

## Phase 3: 개발↔검수 루프 (developer ⇄ reviewer)

1. `developer`가 계획대로 구현, 프로필 §3 타입체크+테스트를 통과시킴. 출력 마지막에 `방법론: superpowers:test-driven-development 따름` 줄이 **있는지 확인** — 없으면 미준수로 되돌린다.
2. `reviewer`가 경계면 정합성(§5)·실패 시나리오·불변식 위반(§4)·제0원칙·테스트를 검수.
3. **보안 트리거 판별:** 변경이 인증/인가·사용자 입력·DB 쿼리·파일시스템·외부 API·암호화·결제·시크릿에 닿으면 `security-reviewer`를 reviewer와 **병렬** dispatch. CRITICAL = 병합 차단.
4. **듀얼 리뷰 (Codex — 연결돼 있으면):** codex MCP 도구(또는 `codex exec --sandbox read-only` CLI)로 같은 diff를 **reviewer와 병렬로** 독립 리뷰시킨다. 통합 시 모든 지적에 출처 태그를 붙인다 — **`[cc]`**(Claude reviewer) / **`[cx]`**(Codex) / **`[cc·cx]`**(둘 다 지적 = 신뢰도 높음, 우선 처리). 심각도 규칙은 출처 무관 동일(CRITICAL/HIGH = 차단). codex 미설치·미인증·호출 실패면 이 단계를 조용히 생략하되 최종 보고에 "듀얼 리뷰 생략(codex 없음)"을 명시한다 — 조용한 성공 위장 금지.
5. **테스트 품질 리뷰 (조건부):** 새 기능·버그수정처럼 테스트가 핵심 방어선인 변경이거나 reviewer가 테스트 품질에 의문을 표하면, `ecc:pr-test-analyzer` 에이전트를 병렬 dispatch — 행동 커버리지 관점("이 테스트가 진짜 버그를 잡는가", assert 없는 테스트·mock 범벅·커버리지 숫자 놀음 적발). 지적은 **`[tq]`** 태그로 통합. 신규 에이전트를 만들지 않고 ECC 참조를 쓰는 이유: 만들기 전에 찾는다(레이어 원칙).
6. 보류(CRITICAL/HIGH — cc·cx·security-reviewer·tq 어느 쪽이든)면 developer로 되돌려 수정 → 재검수. **통과까지 루프.**
7. §3이 런타임/브라우저 관찰을 요구하면 실제 동작 확인까지.

개발 중 새 모호점이 나오면 clarifier로 에스컬레이션.

## Phase 4: PR 작성↔점검 루프 (pr-author ⇄ pr-reviewer)

1. `pr-author`가 §7 정책대로 브랜치→PR 생성 (기본 브랜치에서 새 브랜치, 한 PR=한 변경, Conventional Commits).
2. `pr-reviewer`가 base·파일범위·완결성·정합성·롤백성 점검.
3. 변경요청이면 되돌려 수정 → 재점검. 승인까지 루프.

## Phase 5: 변경 설명 (change-explainer)

`change-explainer`가 실제 diff 기반으로 사용자용 설명(§1의 언어)을 만든다. **설명을 사용자에게 낸 뒤에만** `rm -f .claude/.needs-explain`.

## Phase 6: 완료 감사 게이트 (completion-auditor)

사용자에게 "완료"라고 보고하기 **직전**, `completion-auditor`가 모든 완료 주장을 1차 증거로 재검증한다 — 파일 실존·커밋 존재(push≠커밋)·PR 상태·테스트 실제 실행·실제 동작 관찰·**운영 반영 여부(§6)**. 반증이 하나라도 나오면 "완료"라 말하지 않고, 무엇이 실제로 됐고 안 됐는지 정확히 보고한 뒤 해당 주체로 되돌린다.

**이 게이트는 산문이 아니라 훅으로 강제된다** (`.claude/settings.json`). 코드/설정을 편집하면 `.claude/.needs-audit`·`.needs-explain` 플래그가 서고, Stop 훅이 타입체크(§3, `harness.env`) + 설명 + 감사 없이는 턴 종료를 막는다(rc=2). 감사자가 검증을 통과시킨 **뒤에만** `rm -f .claude/.needs-audit` — 감사 없이 플래그만 지우는 것은 게이트 무력화다. 한 턴 최대 3회 차단 후 벽돌 방지 통과되며, 그때는 완료 주장을 신뢰하지 말 것.

## Phase 7: 머지 (사용자 승인)

**머지는 사용자 승인 후에만.** 승인 시 `gh pr merge --squash --delete-branch`. 머지 후 로컬 기본 브랜치 갱신 + §3 검증 재확인. §6에 배포 절차가 있으면 "머지 ≠ 운영 반영"을 사용자에게 명시.

## 데이터 전달

- **태스크 기반**(TaskCreate): 진행상황·의존관계.
- **파일 기반**(`_workspace/{phase}_{agent}_{artifact}`): 계획서·검수 결과 등 산출물. 최종물만 사용자 경로/PR로, 중간 파일은 보존.
- **메시지 기반**(SendMessage): 루프 중 피드백.
- **프롬프트 주입**(위 주입 규칙): 프로필 섹션·원칙·기억 검색 결과.

## 에러 핸들링

- 에이전트 1회 재시도 후 재실패 시, 결과 없이 진행하되 보고서에 누락 명시.
- 상충 데이터는 삭제하지 말고 출처 병기.
- 파괴적 작업(force push, 브랜치 삭제, 데이터 덮어쓰기)은 실행 전 대상·롤백법 명시하고 필요 시 사용자 확인.
- 프로필이 없거나 §가 비어 있으면: 해당 검증은 "확인 불가"로 명시하고 진행하되, 완료 보고에 "프로필 §N 미작성 — 해당 검증 생략됨"을 남긴다. 지어내지 않는다.

## 진화 신호 감지 (전문 검수자 추가 판단)

"성능/접근성 검수자가 필요한가"를 사람의 기억이나 감에 맡기지 않는다. 신호는 하네스가 쌓고, 판단은 임계치가 한다:

1. **신호 축적**: reviewer는 지적마다 카테고리 태그(`[성능]` `[접근성]` `[국제화]` 등)를 붙인다. 모든 검수 결과는 claude-mem이 자동 캡처하므로 세션이 끝나도 남는다.
2. **집계·판단**: Phase 6 완료 후, 이번 실행에서 **전문 검수자가 없는 카테고리의 HIGH+ 지적**이 나왔다면 `claude-mem:mem-search`로 같은 카테고리 과거 지적을 검색한다(예: `search(query="reviewer 성능 HIGH")`). **누적 3회 이상**이면 사용자에게 제안한다: "[성능] HIGH 지적이 3회 누적됨 — performance-reviewer를 security-reviewer와 같은 조건부 틀로 추가할까요?"
3. **채택 시 — 만들기 전에 먼저 찾는다**: 자체 제작 전에 `find-skills` 스킬로 스킬 생태계에 기존 해법이 있는지 검색한다(`npx skills find <역량>` — 설치 수 1K+·출처 신뢰도 검증 포함). 쓸만한 것이 있으면 전역 설치(`-g`, 참조 레이어 편입)를 사용자에게 제안하고 끝낸다. 없으면 템플릿 repo(정본)에 에이전트를 추가·커밋하고 각 프로젝트에 sync. 어느 쪽이든 CLAUDE.md 변경 이력에 기록.

> 이 규칙 덕에 "언제 에이전트를 추가하나"가 세션 기억과 무관해진다 — 어느 세션의 오케스트레이터든 같은 검색으로 같은 누적치를 복원한다.

## 테스트 시나리오

**정상 흐름**: 사용자가 기능 요청(프로필 §8의 예시 유형) → clarifier(범위·대상 확인 질문) → planner 계획 + plan-reviewer 승인 → developer 구현(TDD, `방법론:` 줄) + reviewer 검수 통과 → pr-author PR + pr-reviewer 승인 → change-explainer 설명 → completion-auditor 검증 → 플래그 정리 → 사용자 승인 후 머지.

**에러 흐름**: reviewer가 §5 경계면 shape 불일치 CRITICAL 발견 → developer로 되돌림 → 수정 + 회귀 테스트 → 재검수 통과 → 이후 정상 진행. (또는: Stop 훅이 타입체크 실패로 종료 차단 → developer가 수정 후 재시도.)

## 파이프라인 밖: 상시 자문 에이전트

`architecture-guide`는 개발 흐름에 속하지 않는다. 사용자가 "이거 왜 이렇게 짰냐 / 남이 물으면 뭐라 답하지"처럼 **구조의 설계 의도**를 물을 때 직접 호출한다(프로젝트 아키텍처·하네스 둘 다). `change-explainer`(특정 PR의 변화)와 구분: 이쪽은 서 있는 구조의 근거. 코드 변경이 없으므로 이 파이프라인을 타지 않는다.

## 후속 작업

"다시/재실행/보완/수정/이전 결과 기반" 요청은 Phase 0에서 `_workspace/` 확인 후 해당 에이전트만 부분 재실행한다. 각 에이전트는 이전 산출물이 있으면 읽고 델타만 반영한다. "검수만 다시" → Phase 3의 reviewer만, "PR만 다시" → Phase 4만 — 단 그 결과가 앞 단계 산출물과 모순되면 해당 앞 단계로 되돌린다.
