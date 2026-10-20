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

set -e

URL="${OPENCODE_SERVER_URL:-http://127.0.0.1:5096}"
USER_NAME="${OPENCODE_SERVER_USERNAME:-opencode}"
PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"
SESSION="${1:-}"

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

systemctl --user restart opencode-lark.service
echo "restart-when-idle: restarted after ${waited}s"
