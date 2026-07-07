---
name: chat-system-pr
description: 검수 통과한 변경을 브랜치→GitHub PR로 올린다. master 직접 커밋 금지, 기능마다 master에서 새 브랜치, squash merge 전제, 한 PR=한 논리적 변경. pr-author 에이전트가 사용. "PR 올려줘/만들어줘", 변경을 PR로 제출할 때 트리거.
---

# 채팅 시스템 PR 작성

검수 통과한 변경을 이 프로젝트의 확정된 버전관리 정책으로 PR화한다.

## 확정 정책 (반드시 준수)

1. **master 직접 커밋 금지.** 브랜치 → PR → squash merge.
2. **기능마다 master에서 새 브랜치.** 스택 PR(브랜치 위 브랜치) 금지 — 앞 PR 머지 시 base 브랜치 삭제로 뒤 PR이 자동으로 닫히는 사고가 실제로 있었다. 항상 최신 master에서 출발.
3. **한 PR = 한 논리적 변경.** squash 후 master에 커밋 하나. 롤백 = `git revert` 하나로 끝나야 한다.
4. **브랜치**: `feature/<설명>` 또는 `fix/<설명>`.
5. **제목**: Conventional Commits (`feat:`/`fix:`/`refactor:`/`docs:`/`test:`/`chore:`/`perf:`).

## 순서

```bash
git status                              # 변경 확인
git checkout master && git pull         # 최신 master
git checkout -b feature/<name>          # 항상 master 기준
git add <이 PR에 속한 파일만>           # 무관한 변경 섞지 않기
git commit -m "feat: ..."               # Conventional Commits, 본문에 무엇을/왜
git push -u origin feature/<name>
gh pr create --base master --title "..." --body "..."
gh pr view <n> --json files --jq '.files[].path'   # diff에 의도한 파일만 있는지 최종 확인
```

## PR 본문

```
## Summary
- 무엇을 왜 바꿨나

## Test plan
- [x] pnpm typecheck
- [x] pnpm test (N tests)
- [x] (해당 시) 브라우저 검증
```

## 파괴적 작업 주의

`git push --force`, 브랜치 삭제, 강제 base 변경은 비가역이다. 실행 전 대상과 롤백 방법(예: "덮어써지는 커밋 SHA는 로컬에 남아 `git push origin <sha>:<branch> --force`로 복원 가능")을 명시한다. 커밋 없이 push부터 하지 않는다 — 스테이징→커밋→push 순서 확인.

## 왜 새 브랜치를 항상 master에서 따나

과거에 스택 PR을 썼다가, 하위 PR의 base 브랜치가 상위 PR 머지와 함께 삭제되어 하위 PR이 통째로 닫히고 diff가 꼬였다. 각 기능을 독립적으로 master에서 분기하면 이 의존이 사라지고, 머지 순서와 무관하게 각 PR이 독립적으로 리뷰·머지·롤백된다.

## 머지

머지는 **사용자 승인 후에만.** 승인 시 `gh pr merge <n> --squash --delete-branch`. 임의 머지 금지.
