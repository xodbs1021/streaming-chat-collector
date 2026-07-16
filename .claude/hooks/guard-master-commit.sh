#!/usr/bin/env bash
# PreToolUse(Bash): master/main 브랜치 위에서의 `git commit` 을 차단한다.
#
# 근거: 버전관리 정책 — "기본 브랜치 직접 커밋 금지.
#       기능마다 기본 브랜치에서 새 브랜치 → PR → squash merge."
#       (프로필 §7 vcs 참조.)
#
# `gh pr merge` 는 일부러 차단하지 않는다. 훅은 "사용자가 승인한 머지"와
# "모델이 독단으로 하는 머지"를 구분할 수 없기 때문이다.
#
# 알려진 한계: 명령 문자열에 git commit 이 들어간 비커밋 명령
# (예: echo "git commit") 도 차단된다. 탈출구로 우회한다.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

HOOK_ID="pre:bash:master-guard"
hook_disabled "$HOOK_ID" && exit 0

payload="$(cat)"
cmd="$(printf '%s' "$payload" | json_get tool_input.command)"
[ -z "$cmd" ] && exit 0

# symbolic-ref 는 unborn HEAD(커밋 0개)에서도 브랜치명을 준다. 실패(detached)면
# rev-parse 폴백 → "HEAD" 는 아래 case 에 안 걸려 통과된다(의도).
branch="$(git -C "$PROJECT_DIR" symbolic-ref --short HEAD 2>/dev/null)" \
  || branch="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)" \
  || exit 0
case "$branch" in
  master|main) ;;
  *) exit 0 ;;
esac

# 초기 커밋(HEAD 미존재)은 허용 — 신생 repo 의 첫 커밋은 기본 브랜치에 앉는 것이
# 관례고, base 커밋 없이는 PR 흐름 자체가 성립하지 않는다. (의도된 fail-open)
git -C "$PROJECT_DIR" rev-parse --verify -q HEAD >/dev/null 2>&1 || exit 0

# `git commit ...` 과 `git -C dir commit ...` / `git -c k=v commit ...` 를 잡는다.
# 앞에 오는 문자가 영숫자/밑줄/하이픈이 아니어야 하므로 `&&`, `;`, 줄머리 뒤도 걸린다.
if ! printf '%s' "$cmd" | grep -Eq \
  -e '(^|[^[:alnum:]_-])git[[:space:]]+commit([[:space:]]|$)' \
  -e '(^|[^[:alnum:]_-])git[[:space:]]+-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+commit([[:space:]]|$)'
then
  exit 0
fi

{
  echo "[정책 차단] 기본 브랜치 직접 커밋 금지 — 버전관리 정책(프로필 §7)"
  echo
  echo "현재 브랜치: $branch"
  echo "차단된 명령: $(printf '%s' "$cmd" | cut -c1-120)"
  echo
  echo "해야 할 일:"
  echo "  git checkout -b feature/<이름>   # 기본 브랜치에서 새 브랜치"
  echo "  git commit ...                   # 브랜치 위에서 커밋"
  echo "  gh pr create ...                 # PR → squash merge (머지는 사용자 승인 후)"
  echo
  echo "정말 기본 브랜치에 직접 커밋해야 한다면:"
  echo "  HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=$HOOK_ID"
} >&2
exit 2
