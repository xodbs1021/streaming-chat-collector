#!/usr/bin/env bash
# 채팅 시스템 하네스 훅 공용 모듈. 각 훅 스크립트가 source 한다.
#
# set -e 를 쓰지 않는다: 훅이 예기치 않게 죽으면 세션이 막히거나(Stop)
# 멀쩡한 명령이 차단된다(PreToolUse). 모든 종료는 명시적으로 한다.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
STATE_DIR="$PROJECT_DIR/.claude"
AUDIT_FLAG="$STATE_DIR/.needs-audit"
EXPLAIN_FLAG="$STATE_DIR/.needs-explain"
BLOCK_COUNT="$STATE_DIR/.stop-block-count"

# Stop 훅이 같은 턴을 최대 몇 번까지 막을 수 있는가. 소진되면 통과시킨다(세션 벽돌 방지).
# 정상 흐름은 1회 차단(감사자 호출)이므로 타입체크 실패용 여유가 2회 남는다.
MAX_BLOCKS=3

# 탈출구.
#   CHAT_HOOKS=off                            → 세 훅 모두 비활성
#   ECC_DISABLED_HOOKS=stop:verify,...        → id 로 개별 비활성
hook_disabled() {
  if [ "${CHAT_HOOKS:-}" = "off" ]; then
    return 0
  fi
  case ",${ECC_DISABLED_HOOKS:-}," in
    *",$1,"*) return 0 ;;
  esac
  return 1
}

# stdin 의 JSON 에서 점 경로로 값 하나를 뽑는다. 없거나 파싱 실패면 빈 문자열.
# 훅 입력이 깨져도 절대 죽지 않는다 — 죽으면 오탐 차단이 된다.
json_get() {
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for key in sys.argv[1].split("."):
    if not isinstance(data, dict):
        sys.exit(0)
    data = data.get(key)
    if data is None:
        sys.exit(0)
print(data)
' "$1" 2>/dev/null
}
