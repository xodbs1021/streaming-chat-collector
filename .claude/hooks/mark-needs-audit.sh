#!/usr/bin/env bash
# PostToolUse(Edit|Write): 코드/설정 파일이 바뀌면 감사 플래그를 세운다.
#
# 이 플래그는 completion-auditor 가 검증을 통과시킨 뒤에만 지워진다.
# Stop 훅이 플래그를 보고 턴 종료를 막는다 → 감사자 호출이 강제된다.
#
# 제외: _workspace/(스크래치), .claude/(하네스 자체), **/*.md(문서)
# 커밋 여부와 무관하게 동작하므로, "커밋해서 트리가 clean해졌으니 통과"
# 같은 구멍이 없다.
#
# PostToolUse 는 절대 차단하지 않는다(도구는 이미 실행됨). 항상 exit 0.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

HOOK_ID="post:edit:needs-audit"
hook_disabled "$HOOK_ID" && exit 0

payload="$(cat)"
file_path="$(printf '%s' "$payload" | json_get tool_input.file_path)"
[ -z "$file_path" ] && exit 0

rel="${file_path#"$PROJECT_DIR"/}"
case "$rel" in
  _workspace/*|.claude/*) exit 0 ;;
  *.md|*.markdown)        exit 0 ;;
esac

mkdir -p "$STATE_DIR" 2>/dev/null
# 두 완료 게이트를 동시에 세운다:
#   .needs-audit   → completion-auditor 강제 (Phase 6)
#   .needs-explain → change-explainer 강제 (Phase 5)
# 둘 다 해당 에이전트가 실제로 돈 뒤에만 각자 수동으로 지워진다. Stop 훅이 둘 다 본다.
for flag in "$AUDIT_FLAG" "$EXPLAIN_FLAG"; do
  if ! grep -qxF "$rel" "$flag" 2>/dev/null; then
    printf '%s\n' "$rel" >> "$flag" 2>/dev/null
  fi
done
exit 0
