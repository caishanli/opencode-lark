#!/usr/bin/env bash
# opencode-lark installer / updater / remover.
#
#   bash install.sh            install everything (also the default)
#   bash install.sh update     pull the code and restart when the turn is idle
#   bash install.sh remove     stop and remove the service
#
# One-liner on a fresh Ubuntu machine:
#   curl -fsSL https://raw.githubusercontent.com/caishanli/opencode-lark/main/install.sh | bash
#
# Reusing an existing Feishu app (no prompts at all):
#   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx OPENCODE_SERVER_PASSWORD=xxx bash install.sh
#
# Environment:
#   OPENCODE_LARK_DIR          where to clone/install        (default ~/opencode-lark)
#   OPENCODE_LARK_REPO_URL     git URL to clone from
#   OPENCODE_SERVER_URL        server the bridge talks to    (default http://127.0.0.1:4096)
#   OPENCODE_SERVER_PASSWORD   the server's Basic auth password (prompted if unset)
#   OPENCODE_LARK_NO_SERVICE=1 do not touch systemd (asks install/update to skip it)

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
UNIT_FILE="$HOME/.config/systemd/user/opencode-lark.service"
STATE_DIR="$HOME/.local/state/opencode-lark"
REPO=""
SERVER_URL="${OPENCODE_SERVER_URL:-http://127.0.0.1:4096}"
STARTED_SERVER_PID=""

cleanup() {
  if [ -n "$STARTED_SERVER_PID" ]; then
    kill "$STARTED_SERVER_PID" 2>/dev/null || true
    STARTED_SERVER_PID=""
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
用法: install.sh [命令]

  install            安装：依赖 + 飞书配置 + systemd 服务 + 开机自启（默认）
  update             拉取最新代码、更新依赖，空闲时重启服务
  remove [--purge]   停止并移除服务；--purge 同时删除配置和 data

环境变量见脚本头部注释。
EOF
}

is_ubuntu() {
  [ -r /etc/os-release ] && ( . /etc/os-release; [ "${ID:-}" = "ubuntu" ] )
}

has_systemd() {
  [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

# ── Locate the repository ────────────────────────────────────────────────────
resolve_repo() {
  local script_dir=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  if [ -n "$script_dir" ] && [ -f "$script_dir/src/index.ts" ]; then
    REPO="$script_dir"
  elif [ -f "$PWD/src/index.ts" ] && [ -f "$PWD/package.json" ]; then
    REPO="$PWD"
  else
    REPO="${OPENCODE_LARK_DIR:-$HOME/opencode-lark}"
    return 1
  fi
  REPO="$(cd "$REPO" && pwd)"
  return 0
}

ensure_repo() {
  if resolve_repo && [ -f "$REPO/src/index.ts" ]; then
    ok "仓库: $REPO"
    return 0
  fi
  command -v git >/dev/null 2>&1 || die "git is required to clone the repository"
  REPO="${OPENCODE_LARK_DIR:-$HOME/opencode-lark}"
  say "克隆 opencode-lark 到 $REPO"
  local url="${OPENCODE_LARK_REPO_URL:-git@github.com:caishanli/opencode-lark.git}"
  if ! git clone --depth 1 "$url" "$REPO"; then
    warn "SSH 克隆失败，改用 HTTPS"
    git clone --depth 1 https://github.com/caishanli/opencode-lark.git "$REPO"
  fi
  REPO="$(cd "$REPO" && pwd)"
  ok "仓库: $REPO"
}

# ── Tools ────────────────────────────────────────────────────────────────────
require_bun() {
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
}

require_opencode() {
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
}

install_deps() {
  say "安装依赖"
  (cd "$REPO" && "$BUN" install --silent)
  ok "依赖已安装"
}

find_env_file() {
  find "$CONFIG_DIR" -maxdepth 1 -name '.env.*' -print -quit 2>/dev/null || true
}

# ── Feishu credentials ───────────────────────────────────────────────────────
configure() {
  local existing_env
  existing_env="$(find_env_file)"
  if [ -n "$existing_env" ]; then
    ok "已存在配置: $existing_env"
    return 0
  fi

  if [ -n "${FEISHU_APP_ID:-}" ] && [ -n "${FEISHU_APP_SECRET:-}" ]; then
    [ -n "${OPENCODE_SERVER_PASSWORD:-}" ] || die "请同时设置 OPENCODE_SERVER_PASSWORD"
    say "写入飞书配置"
    mkdir -p "$CONFIG_DIR"
    local env_file="$CONFIG_DIR/.env.$FEISHU_APP_ID"
    {
      printf 'FEISHU_APP_ID=%s\n' "$FEISHU_APP_ID"
      printf 'FEISHU_APP_SECRET=%s\n' "$FEISHU_APP_SECRET"
      printf 'OPENCODE_SERVER_URL=%s\n' "$SERVER_URL"
      printf 'OPENCODE_SERVER_USERNAME=opencode\n'
      printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$OPENCODE_SERVER_PASSWORD"
    } > "$env_file"
    chmod 600 "$env_file"
    ok "配置已写入 $env_file"
    return 0
  fi

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
    local port
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
}

# ── systemd service (Ubuntu: additionally starts at boot) ────────────────────
install_service() {
  if [ "${OPENCODE_LARK_NO_SERVICE:-0}" = "1" ] || ! has_systemd; then
    warn "跳过 systemd 服务；手动启动：cd $REPO && $BUN run src/index.ts"
    return 0
  fi

  say "安装 systemd 服务"
  mkdir -p "$(dirname "$UNIT_FILE")" "$STATE_DIR"
  sed -n '/^\[Unit\]/,$p' "$REPO/packaging/opencode-lark.service" \
    | sed -e "s#__REPO__#$REPO#g" -e "s#__BUN__#$BUN#g" -e "s#__STATE__#$HOME/.local/state#g" \
    > "$UNIT_FILE"
  systemctl --user daemon-reload

  if systemctl --user is-active --quiet opencode-lark; then
    ok "服务已在运行（改动代码后用 $REPO/scripts/restart-when-idle.sh 重启）"
  else
    systemctl --user enable --now opencode-lark
    ok "服务已启动"
  fi

  if ! is_ubuntu; then
    note "非 Ubuntu：服务已安装，但没有配置开机自启"
    return 0
  fi

  # Ubuntu: the user manager only starts at boot with lingering enabled.
  systemctl --user enable opencode-lark >/dev/null
  if loginctl enable-linger "$USER"; then
    ok "开机自启已开启（systemd user + linger）"
  else
    warn "loginctl enable-linger 失败，注销后服务会停止；重启后需要重新登录"
  fi
}

# ── Commands ─────────────────────────────────────────────────────────────────
do_install() {
  ensure_repo
  require_bun
  require_opencode
  install_deps
  configure
  install_service

  printf '\n'
  say "完成。"
  printf '  日志:  %s\n' "$STATE_DIR/bridge.log"
  printf '  状态:  systemctl --user status opencode-lark\n'
  printf '  重启:  %s/scripts/restart-when-idle.sh\n' "$REPO"
  printf '  更新:  bash %s/install.sh update\n' "$REPO"
  printf '  卸载:  bash %s/install.sh remove\n\n' "$REPO"
  printf '%s\n' "${BOLD}飞书后台还需要（一次性）：${NC}"
  printf '  1. 权限: im:message / im:message.p2p_msg:readonly / im:message.group_msg / im:resource / cardkit:card:write\n'
  printf '  2. 事件订阅（长连接）: im.message.receive_v1\n'
  printf '  3. 回调订阅（长连接）: card.action.trigger   ← 少了它卡片按钮会报 200340\n'
  printf '%s\n' "${DIM}  保存长连接设置前服务必须在跑；应用发布后把机器人拉进群。${NC}"
}

do_update() {
  if ! resolve_repo || [ ! -f "$REPO/src/index.ts" ]; then
    die "找不到仓库（${REPO:-$HOME/opencode-lark}），先运行 install.sh install"
  fi
  require_bun

  if [ -d "$REPO/.git" ]; then
    if git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
      say "拉取最新代码"
      git -C "$REPO" pull --ff-only
    else
      warn "当前分支没有上游，跳过 git pull"
    fi
  fi

  install_deps

  if [ "${OPENCODE_LARK_NO_SERVICE:-0}" = "1" ] || ! has_systemd; then
    note "跳过服务重启；手动重启：cd $REPO && $BUN run src/index.ts"
    return 0
  fi
  if ! systemctl --user is-active --quiet opencode-lark; then
    note "服务未运行，跳过重启（用 systemctl --user start opencode-lark 启动）"
    return 0
  fi

  # The idle-aware restart needs the server URL and password the bridge uses.
  local env_file
  env_file="$(find_env_file)"
  if [ -n "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
  say "空闲时重启服务"
  ( cd "$REPO" && scripts/restart-when-idle.sh )
}

do_remove() {
  local purge=0
  [ "${2:-}" = "--purge" ] && purge=1

  if has_systemd; then
    say "停止并移除服务"
    systemctl --user disable --now opencode-lark >/dev/null 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload || true
    ok "服务已移除"
  else
    note "没有 systemd，跳过服务"
  fi

  if [ "$purge" = "1" ]; then
    say "删除配置和数据"
    rm -rf "$CONFIG_DIR"
    if resolve_repo && [ -d "$REPO/data" ]; then
      rm -rf "$REPO/data"
    fi
    ok "配置和数据已删除"
  else
    note "配置保留在 $CONFIG_DIR（加 --purge 一并删除）"
    if resolve_repo && [ -d "$REPO/data" ]; then
      note "会话映射保留在 $REPO/data"
    fi
  fi

  note "代码目录没有删除；需要的话手动 rm -rf ${REPO:-$HOME/opencode-lark}"
  note "如果不再需要，注销后自启也一并失效（loginctl disable-linger $USER 可立即关闭）"
}

case "${1:-install}" in
  install) do_install ;;
  update)  do_update ;;
  remove)  do_remove "$@" ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
