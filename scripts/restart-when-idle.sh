#!/bin/sh
# Restart the opencode-lark bridge, but only once the given opencode session
# is idle — a restart in the middle of a turn kills the stream and leaves the
# reply card stuck on "interrupted".
#
#   scripts/restart-when-idle.sh [session_id]
#
# Environment:
#   OPENCODE_SERVER_URL       default http://127.0.0.1:5096
#   OPENCODE_SERVER_PASSWORD  Basic-auth password (default: opencode)
#   OPENCODE_SERVER_USERNAME  Basic-auth username (default: opencode)
#
# The chat the bridge last served gets two messages: one right before the
# restart and one once the webhook port answers again.

set -e

URL="${OPENCODE_SERVER_URL:-http://127.0.0.1:5096}"
USER_NAME="${OPENCODE_SERVER_USERNAME:-opencode}"
PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"
SESSION="${1:-}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-$(command -v bun 2>/dev/null || true)}"
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
fi

notify() {
  [ -n "$BUN" ] || return 0
  "$BUN" "$REPO/scripts/notify-feishu.ts" "$1" >/dev/null 2>&1 || true
}

waited=0
while :; do
  active=$(curl -s -m 5 -u "$USER_NAME:$PASSWORD" "$URL/api/session/active" 2>/dev/null || echo "")

  if [ -z "$SESSION" ]; then
    # No session given: restart when NO session is running at all.
    case "$active" in
      *'"data":{}'*|*'"data":null'*) break ;;
      "") break ;;
    esac
  else
    # Restart when this session is not in the active (running) map.
    case "$active" in
      *"$SESSION"*) ;;
      *) break ;;
    esac
  fi

  sleep 3
  waited=$((waited + 3))
  if [ "$waited" -ge 900 ]; then
    echo "restart-when-idle: giving up after ${waited}s" >&2
    break
  fi
done

notify "🔄 opencode-lark 即将重启（本轮已结束），稍等…"
started=$(date +%s)

systemctl --user restart opencode-lark.service

# Wait for the bridge's webhook server: any HTTP answer means it is up.
tries=0
while [ "$tries" -lt 60 ]; do
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:3001/ 2>/dev/null || echo "000")
  [ "$code" != "000" ] && break
  sleep 1
  tries=$((tries + 1))
done

took=$(( $(date +%s) - started ))
notify "✅ opencode-lark 已重启完成（${took}s）"
echo "restart-when-idle: restarted after ${waited}s (startup ${took}s)"
