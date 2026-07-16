#!/usr/bin/env bash
# Stop: 코드를 건드린 턴은 (1) 타입체크 통과 (2) change-explainer 실행
#       (3) completion-auditor 실행 없이는 끝낼 수 없다.
#
# 무한루프 가드: 같은 턴을 MAX_BLOCKS(3)회까지만 막는다. 소진되면 플래그를
# 지우고 통과시키되 사용자에게 큰 경고를 띄운다. 세션이 벽돌이 되는 것보다
# 낫다. 카운터 파일을 못 쓰는 환경이면 stop_hook_active 로 폴백한다.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

HOOK_ID="stop:verify"
hook_disabled "$HOOK_ID" && exit 0

payload="$(cat)"
stop_active="$(printf '%s' "$payload" | json_get stop_hook_active)"

# (1) 코드 변경이 없는 턴 → 검사 전부 생략. 읽기 전용 질문에 타입체크를 돌리지 않는다.
#     두 게이트 플래그(감사·설명)가 모두 비어야 "할 일 없음"이다.
if [ ! -s "$AUDIT_FLAG" ] && [ ! -s "$EXPLAIN_FLAG" ]; then
  rm -f "$BLOCK_COUNT" 2>/dev/null
  exit 0
fi

# (2) 카운터 확인 — 벽돌 방지
count=0
if [ -f "$BLOCK_COUNT" ]; then
  count="$(tr -dc '0-9' < "$BLOCK_COUNT" 2>/dev/null)"
fi
[ -z "$count" ] && count=0

if [ "$count" -ge "$MAX_BLOCKS" ]; then
  changed="$(cat "$AUDIT_FLAG" "$EXPLAIN_FLAG" 2>/dev/null | tr -d '"\\' | sort -u | tr '\n' ' ')"
  rm -f "$AUDIT_FLAG" "$EXPLAIN_FLAG" "$BLOCK_COUNT" 2>/dev/null
  printf '{"systemMessage":"[완료 게이트] %s회 차단 후에도 미해결이라 세션 벽돌 방지를 위해 통과시킵니다. 이 턴의 완료 주장(및 변경 설명)을 신뢰하지 마세요. 미처리 변경: %s"}\n' \
    "$MAX_BLOCKS" "$changed"
  exit 0
fi

bump_and_block() {
  if ! printf '%s\n' "$((count + 1))" > "$BLOCK_COUNT" 2>/dev/null; then
    # 카운터를 못 쓰면 무한루프 위험 → 표준 가드로 폴백
    case "$stop_active" in
      [Tt]rue) exit 0 ;;
    esac
  fi
  exit 2
}

# (3) 타입체크 — 결정론적 바닥. 명령은 프로필에서 파생된 harness.env 에서 읽는다.
#     HARNESS_TYPECHECK_CMD 가 비어 있으면(타입 없는 언어/미설정) 생략한다.
#     이렇게 하면 이 훅이 특정 스택(pnpm/tsc)에 묶이지 않는다 — 도메인-무관 재사용.
typecheck_note=""
if [ -f "$STATE_DIR/harness/harness.env" ]; then
  # shellcheck disable=SC1091
  . "$STATE_DIR/harness/harness.env" 2>/dev/null
fi
TYPECHECK_CMD="${HARNESS_TYPECHECK_CMD:-}"

if [ -z "$TYPECHECK_CMD" ]; then
  typecheck_note="타입체크 생략 (harness.env 에 HARNESS_TYPECHECK_CMD 미설정)"
else
  timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  fi
  # macOS 기본에는 timeout 이 없다. 그 경우 settings.json 의 "timeout": 120 이 최종 안전망.

  if [ -n "$timeout_bin" ]; then
    tc_out="$(cd "$PROJECT_DIR" && "$timeout_bin" 90 sh -c "$TYPECHECK_CMD" 2>&1)"; tc_rc=$?
  else
    tc_out="$(cd "$PROJECT_DIR" && sh -c "$TYPECHECK_CMD" 2>&1)"; tc_rc=$?
  fi

  if [ "$tc_rc" -eq 124 ] || [ "$tc_rc" -eq 137 ]; then
    # 타임아웃은 "타입 오류"가 아니라 "모름". 차단하지 않고 감사자에게 넘긴다.
    typecheck_note="타입체크 타임아웃 → 생략 (감사자가 재확인할 것)"
  elif [ "$tc_rc" -eq 127 ]; then
    # 명령/도구 없음(rc=127)은 "타입 오류"가 아니다. 오탐 차단 방지 위해 생략.
    typecheck_note="타입체크 생략 (명령 실행 불가 rc=127): $TYPECHECK_CMD"
  elif [ "$tc_rc" -ne 0 ]; then
    {
      echo "[완료 차단] 타입체크 실패 — 지금은 '완료'가 아닙니다."
      echo
      echo "명령: $TYPECHECK_CMD"
      echo
      printf '%s\n' "$tc_out" | head -n 15
      echo
      echo "고친 뒤 다시 종료하세요.  (차단 $((count + 1))/${MAX_BLOCKS})"
      echo "탈출구: HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=$HOOK_ID"
    } >&2
    bump_and_block
  fi
fi

# (4) change-explainer 게이트 (Phase 5) — 감사자보다 먼저 강제한다.
#     코드가 바뀐 턴은 변경 설명 없이 끝낼 수 없다. change-explainer 가 실제로
#     사용자용 설명을 낸 뒤에만 .needs-explain 을 지운다.
#     (완료 감사와 별개로 이 게이트만 끄려면 ECC_DISABLED_HOOKS=stop:explain)
if [ -s "$EXPLAIN_FLAG" ] && ! hook_disabled "stop:explain"; then
  {
    echo "[완료 차단] change-explainer 미실행 — 변경 설명 없이 끝낼 수 없습니다."
    echo
    echo "이 턴에서 바뀐 코드/설정:"
    sed 's/^/  - /' "$EXPLAIN_FLAG" 2>/dev/null
    echo
    echo "해야 할 일:"
    echo "  1. change-explainer 에이전트로 실제 diff 기반 사용자용 변경 설명을 낸다."
    echo "  2. 설명을 낸 뒤에만:  rm -f .claude/.needs-explain"
    echo "     설명 없이 플래그만 지우는 것은 이 게이트의 존재 이유를 없앤다."
    echo
    echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구: HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:explain"
  } >&2
  bump_and_block
fi

# (5) 타입체크는 통과했지만 감사자가 아직 안 돌았다.
{
  echo "[완료 차단] completion-auditor 미실행 — '완료'라고 말할 수 없습니다."
  echo
  echo "이 턴에서 바뀐 코드/설정:"
  sed 's/^/  - /' "$AUDIT_FLAG" 2>/dev/null
  if [ -n "$typecheck_note" ]; then
    echo
    echo "참고: $typecheck_note"
  fi
  echo
  echo "해야 할 일:"
  echo "  1. completion-auditor 에이전트로 완료 주장을 1차 증거로 검증한다."
  echo "  2. 검증을 통과했을 때만:  rm -f .claude/.needs-audit"
  echo "     감사 없이 플래그만 지우는 것은 이 게이트의 존재 이유를 없앤다."
  echo
  echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구: HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=$HOOK_ID"
} >&2
bump_and_block
