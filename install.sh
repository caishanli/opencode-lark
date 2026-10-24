#!/usr/bin/env bash
# One-shot installer for opencode-lark on a fresh machine.
#
# It installs bun and opencode when they are missing, clones the repo, installs
# its dependencies, configures the Feishu app (QR wizard, or the credentials you
# pass in), and installs the systemd user service that keeps the bridge running.
#
#   bash install.sh
#   curl -fsSL https://raw.githubusercontent.com/caishanli/opencode-lark/main/install.sh | bash
#
# Non-interactive (reusing an existing Feishu app):
#   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx OPENCODE_SERVER_PASSWORD=xxx bash install.sh
#
# Environment:
#   OPENCODE_LARK_DIR          where to clone/install        (default ~/opencode-lark)
#   OPENCODE_LARK_REPO_URL     git URL to clone from
#   OPENCODE_SERVER_URL        server the bridge talks to    (default http://127.0.0.1:4096)
#   OPENCODE_SERVER_PASSWORD   the server's Basic auth password (prompted if unset)
#   OPENCODE_LARK_NO_SERVICE=1 skip the systemd unit
#
# Safe to re-run: existing configuration is kept and a running service is not
# restarted (that would interrupt a turn — use scripts/restart-when-idle.sh).

set -euo pipefail

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; NC=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; NC=""
fi

say()  { printf '%s\n' "${BOLD}$*${NC}"; }
note() { printf '%s\n' "${DIM}$*${NC}"; }
ok()   { printf '%s\n' "${GREEN}✓ $*${NC}"; }
warn() { printf '%s\n' "${YELLOW}! $*${NC}"; }
die()  { printf '%s\n' "${RED}✗ $*${NC}" >&2; exit 1; }

CONFIG_DIR="$HOME/.config/opencode-lark"
SERVER_URL="${OPENCODE_SERVER_URL:-http://127.0.0.1:4096}"
STARTED_SERVER_PID=""

cleanup() {
  if [ -n "$STARTED_SERVER_PID" ]; then
    kill "$STARTED_SERVER_PID" 2>/dev/null || true
    STARTED_SERVER_PID=""
  fi
}
trap cleanup EXIT

# ── Locate (or clone) the repository ─────────────────────────────────────────
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/src/index.ts" ]; then
  REPO="$SCRIPT_DIR"
elif [ -f "$PWD/src/index.ts" ] && [ -f "$PWD/package.json" ]; then
  REPO="$PWD"
else
  REPO="${OPENCODE_LARK_DIR:-$HOME/opencode-lark}"
  if [ ! -f "$REPO/src/index.ts" ]; then
    command -v git >/dev/null 2>&1 || die "git is required to clone the repository"
    URL="${OPENCODE_LARK_REPO_URL:-git@github.com:caishanli/opencode-lark.git}"
    say "克隆 opencode-lark 到 $REPO"
    if ! git clone --depth 1 "$URL" "$REPO"; then
      warn "SSH 克隆失败，改用 HTTPS"
      git clone --depth 1 https://github.com/caishanli/opencode-lark.git "$REPO"
    fi
  fi
fi
REPO="$(cd "$REPO" && pwd)"
ok "仓库: $REPO"

# ── Bun ──────────────────────────────────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  say "安装 Bun"
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
fi
[ -x "$BUN" ] || die "Bun 安装失败（https://bun.sh）"
ok "bun: $BUN"

# ── opencode ─────────────────────────────────────────────────────────────────
OPENCODE_BIN="$(command -v opencode 2>/dev/null || true)"
if [ -z "$OPENCODE_BIN" ] && [ -x "$HOME/.opencode/bin/opencode" ]; then
  OPENCODE_BIN="$HOME/.opencode/bin/opencode"
fi
if [ -z "$OPENCODE_BIN" ]; then
  say "安装 opencode"
  curl -fsSL https://opencode.ai/v2/install | bash
  OPENCODE_BIN="$HOME/.opencode/bin/opencode"
fi
[ -x "$OPENCODE_BIN" ] || die "opencode 安装失败（https://opencode.ai）"
ok "opencode: $OPENCODE_BIN ($("$OPENCODE_BIN" --version 2>/dev/null | head -1))"

# ── Dependencies ─────────────────────────────────────────────────────────────
say "安装依赖"
(cd "$REPO" && "$BUN" install --silent)
ok "依赖已安装"

# ── Feishu credentials ───────────────────────────────────────────────────────
existing_env="$(find "$CONFIG_DIR" -maxdepth 1 -name '.env.*' -print -quit 2>/dev/null || true)"
if [ -n "$existing_env" ]; then
  ok "已存在配置: $existing_env"
elif [ -n "${FEISHU_APP_ID:-}" ] && [ -n "${FEISHU_APP_SECRET:-}" ]; then
  [ -n "${OPENCODE_SERVER_PASSWORD:-}" ] || die "请同时设置 OPENCODE_SERVER_PASSWORD"
  say "写入飞书配置"
  mkdir -p "$CONFIG_DIR"
  env_file="$CONFIG_DIR/.env.$FEISHU_APP_ID"
  {
    printf 'FEISHU_APP_ID=%s\n' "$FEISHU_APP_ID"
    printf 'FEISHU_APP_SECRET=%s\n' "$FEISHU_APP_SECRET"
    printf 'OPENCODE_SERVER_URL=%s\n' "$SERVER_URL"
    printf 'OPENCODE_SERVER_USERNAME=opencode\n'
    printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$OPENCODE_SERVER_PASSWORD"
  } > "$env_file"
  chmod 600 "$env_file"
  ok "配置已写入 $env_file"
else
  if ! [ -t 0 ] && ! [ -r /dev/tty ]; then
    die "没有终端可交互：请设置 FEISHU_APP_ID / FEISHU_APP_SECRET / OPENCODE_SERVER_PASSWORD"
  fi

  say "配置飞书应用（扫码创建，或手动输入 App ID / App Secret）"
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    read -rsp "  opencode server 密码（Basic auth）: " OPENCODE_SERVER_PASSWORD
    printf '\n'
    [ -n "$OPENCODE_SERVER_PASSWORD" ] || die "密码不能为空"
  fi
  export OPENCODE_SERVER_PASSWORD

  # The wizard verifies the server, so it has to be up first.
  server_up() {
    curl -sf -u "opencode:${OPENCODE_SERVER_PASSWORD}" "${SERVER_URL}/api/session/active" >/dev/null 2>&1
  }
  if ! server_up; then
    port="$(printf '%s' "$SERVER_URL" | sed -E 's#^.*:([0-9]+).*$#\1#')"
    note "临时启动 opencode server（端口 $port），配置完成后会自动关掉"
    "$OPENCODE_BIN" serve --port "$port" --hostname 127.0.0.1 \
      >"${TMPDIR:-/tmp}/opencode-lark-install-server.log" 2>&1 &
    STARTED_SERVER_PID=$!
    for _ in $(seq 1 50); do server_up && break; sleep 0.2; done
    server_up || die "opencode server 没有起来，见 ${TMPDIR:-/tmp}/opencode-lark-install-server.log"
  fi

  if [ -t 0 ]; then
    (cd "$REPO" && "$BUN" run src/index.ts init)
  else
    (cd "$REPO" && "$BUN" run src/index.ts init < /dev/tty)
  fi

  chmod 600 "$CONFIG_DIR"/.env.* 2>/dev/null || true
  ok "飞书配置完成"
fi

# ── systemd user service ─────────────────────────────────────────────────────
if [ "${OPENCODE_LARK_NO_SERVICE:-0}" = "1" ] || ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  warn "跳过 systemd 服务；手动启动：cd $REPO && $BUN run src/index.ts"
else
  say "安装 systemd 服务"
  mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/state/opencode-lark"
  sed -n '/^\[Unit\]/,$p' "$REPO/packaging/opencode-lark.service" \
    | sed -e "s#__REPO__#$REPO#g" -e "s#__BUN__#$BUN#g" -e "s#__STATE__#$HOME/.local/state#g" \
    > "$HOME/.config/systemd/user/opencode-lark.service"
  systemctl --user daemon-reload
  if systemctl --user is-active --quiet opencode-lark; then
    ok "服务已在运行（改动代码后用 $REPO/scripts/restart-when-idle.sh 重启）"
  else
    systemctl --user enable --now opencode-lark
    ok "服务已启动"
  fi
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "loginctl enable-linger 失败，注销后服务可能停止"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
printf '\n'
say "完成。"
printf '  日志:  %s\n' "$HOME/.local/state/opencode-lark/bridge.log"
printf '  状态:  systemctl --user status opencode-lark\n'
printf '  重启:  %s/scripts/restart-when-idle.sh\n' "$REPO"
printf '  目录:  桥默认在 %s 发现 opencode 会话（在 %s/.env.* 里设 OPENCODE_CWD 可改）\n\n' "$REPO" "$CONFIG_DIR"

printf '%s\n' "${BOLD}飞书后台还需要（一次性）：${NC}"
printf '  1. 权限: im:message / im:message.p2p_msg:readonly / im:message.group_msg / im:resource / cardkit:card:write\n'
printf '  2. 事件订阅（长连接）: im.message.receive_v1\n'
printf '  3. 回调订阅（长连接）: card.action.trigger   ← 少了它卡片按钮会报 200340\n'
printf '%s\n' "${DIM}  保存长连接设置前服务必须在跑；应用发布后把机器人拉进群。${NC}"
