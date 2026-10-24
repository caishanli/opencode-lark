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

# The script dies when systemd tears down the service cgroup, so the "done"
# message is sent by the new process: leave it a marker to read.
chat=""
if [ -f "$REPO/data/notify-chat.json" ]; then
  chat=$(sed -n 's/.*"chatId":"\([^"]*\)".*/\1/p' "$REPO/data/notify-chat.json")
fi
if [ -n "$chat" ]; then
  printf '{"chatId":"%s","startedAt":%s}' "$chat" "$(( $(date +%s) * 1000 ))" \
    > "$REPO/data/restart-pending.json"
fi

systemctl --user restart opencode-lark.service
echo "restart-when-idle: restarted after ${waited}s"
