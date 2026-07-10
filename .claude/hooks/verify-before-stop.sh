#!/usr/bin/env bash
# Stop: 코드를 건드린 턴은 (1) 타입체크 통과 (2) completion-auditor 실행
#       없이는 끝낼 수 없다.
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

# (1) 코드 변경이 없는 턴 → 검사 전부 생략. 읽기 전용 질문에 tsc 를 돌리지 않는다.
if [ ! -s "$AUDIT_FLAG" ]; then
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
  changed="$(tr -d '"\\' < "$AUDIT_FLAG" 2>/dev/null | tr '\n' ' ')"
  rm -f "$AUDIT_FLAG" "$BLOCK_COUNT" 2>/dev/null
  printf '{"systemMessage":"[감사 게이트] %s회 차단 후에도 미해결이라 세션 벽돌 방지를 위해 통과시킵니다. 이 턴의 완료 주장을 신뢰하지 마세요. 미감사 변경: %s"}\n' \
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

# (3) 타입체크 — 결정론적 바닥. 감사자가 뭘 하든 컴파일 실패는 무조건 걸린다.
typecheck_note=""
if [ ! -d "$PROJECT_DIR/node_modules" ] || ! command -v pnpm >/dev/null 2>&1; then
  # 의존성이 없으면 tsc 가 rc=127 로 죽는다. 이걸 타입 오류로 오인하면 오탐 차단이 된다.
  typecheck_note="타입체크 생략 (node_modules 또는 pnpm 없음)"
else
  timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  fi
  # macOS 기본에는 timeout 이 없다. 그 경우 settings.json 의 "timeout": 120 이 최종 안전망.

  mkdir -p "$PROJECT_DIR/node_modules/.cache" 2>/dev/null
  tsc_argv=(exec tsc --noEmit --incremental --tsBuildInfoFile node_modules/.cache/tsc-hook.tsbuildinfo)

  if [ -n "$timeout_bin" ]; then
    tsc_out="$(cd "$PROJECT_DIR" && "$timeout_bin" 90 pnpm "${tsc_argv[@]}" 2>&1)"; tsc_rc=$?
  else
    tsc_out="$(cd "$PROJECT_DIR" && pnpm "${tsc_argv[@]}" 2>&1)"; tsc_rc=$?
  fi

  if [ "$tsc_rc" -eq 124 ] || [ "$tsc_rc" -eq 137 ]; then
    # 타임아웃은 "타입 오류"가 아니라 "모름". 차단하지 않고 감사자에게 넘긴다.
    typecheck_note="타입체크 타임아웃 → 생략 (감사자가 재확인할 것)"
  elif [ "$tsc_rc" -ne 0 ]; then
    {
      echo "[완료 차단] 타입체크 실패 — 지금은 '완료'가 아닙니다."
      echo
      printf '%s\n' "$tsc_out" | head -n 15
      echo
      echo "고친 뒤 다시 종료하세요.  (차단 $((count + 1))/${MAX_BLOCKS})"
      echo "탈출구: CHAT_HOOKS=off  또는  ECC_DISABLED_HOOKS=$HOOK_ID"
    } >&2
    bump_and_block
  fi
fi

# (4) 타입체크는 통과했지만 감사자가 아직 안 돌았다.
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
  echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구: CHAT_HOOKS=off  또는  ECC_DISABLED_HOOKS=$HOOK_ID"
} >&2
bump_and_block
