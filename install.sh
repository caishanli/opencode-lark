#!/usr/bin/env bash
# opencode-lark installer / updater / remover.
#
#   bash install.sh            install everything (also the default)
#   bash install.sh update     pull the code and restart when the turn is idle
#   bash install.sh remove     stop and remove the service
#   bash install.sh help       this list
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
REPO_UPDATED=0

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
  config             重新配置飞书应用（换应用 / 换凭据）并重启服务
  update             拉取最新代码、更新依赖，空闲时重启服务
  remove [--purge]   停止并移除服务；--purge 同时删除配置和 data
  help               显示这段说明

环境变量见脚本头部注释。
EOF
}

# /dev/tty exists even when there is no controlling terminal; opening it is
# the only reliable test (a piped `curl | bash` has no usable stdin).
have_tty() {
  ( exec 3</dev/tty ) 2>/dev/null
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

# Bring an existing clone up to date. Sets REPO_UPDATED=1 when HEAD moved, so
# the service can be restarted after the code changed.
update_clone() {
  REPO_UPDATED=0
  [ -d "$REPO/.git" ] || return 0
  if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null || true)" ]; then
    warn "仓库有本地改动，跳过更新"
    return 0
  fi
  if ! git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    note "当前分支没有上游，跳过更新"
    return 0
  fi
  local before after
  before="$(git -C "$REPO" rev-parse HEAD)"
  say "更新代码"
  if ! git -C "$REPO" pull --ff-only --quiet; then
    warn "git pull 失败，继续用当前代码"
    return 0
  fi
  after="$(git -C "$REPO" rev-parse HEAD)"
  if [ "$before" = "$after" ]; then
    ok "代码已是最新 ($(git -C "$REPO" log --oneline -1))"
  else
    REPO_UPDATED=1
    ok "代码已更新: $(git -C "$REPO" log --oneline -1)"
  fi
}

# Restart through the idle-aware script with the bridge's own credentials.
restart_bridge() {
  local env_file
  env_file="$(find_env_file)"
  if [ -n "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
  ( cd "$REPO" && scripts/restart-when-idle.sh )
}

ensure_repo() {
  # resolve_repo returns non-zero when the script is not inside the repository,
  # but it still fills REPO with the default location — which may already be a
  # clone from an earlier run.
  resolve_repo || true
  if [ -f "$REPO/src/index.ts" ]; then
    REPO="$(cd "$REPO" && pwd)"
    ok "仓库: $REPO"
    update_clone
    return 0
  fi
  if [ -e "$REPO" ] && [ -n "$(ls -A "$REPO" 2>/dev/null)" ]; then
    die "目录 $REPO 已存在但不是 opencode-lark 仓库；删掉它，或用 OPENCODE_LARK_DIR 指定别的目录"
  fi
  command -v git >/dev/null 2>&1 || die "git is required to clone the repository"
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
write_env_from_environment() {
  [ -n "${FEISHU_APP_ID:-}" ] && [ -n "${FEISHU_APP_SECRET:-}" ] || return 1
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
}

# The wizard creates (or connects) the Feishu app through the QR flow, which
# also provisions the bot scopes and the card callback.
run_wizard() {
  if ! [ -t 0 ] && ! have_tty; then
    return 1
  fi

  # ── opencode server: port + password ──
  say "配置 opencode server"
  if [ -n "${OPENCODE_SERVER_URL:-}" ]; then
    note "使用 OPENCODE_SERVER_URL=${OPENCODE_SERVER_URL}"
  else
    local port_input=""
    read -rp "  监听端口 [4096]: " port_input < /dev/tty || port_input=""
    port_input="${port_input:-4096}"
    case "$port_input" in
      ''|*[!0-9]*) die "端口必须是数字: $port_input" ;;
    esac
    if [ "$port_input" -lt 1 ] || [ "$port_input" -gt 65535 ]; then
      die "端口超出范围: $port_input"
    fi
    SERVER_URL="http://127.0.0.1:$port_input"
    export OPENCODE_SERVER_URL="$SERVER_URL"
  fi

  say "配置飞书应用（扫码自动创建并授权，或手动输入 App ID / App Secret）"
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    # `curl … | bash` leaves stdin at EOF (it is the script's own pipe), so the
    # prompts must read the controlling terminal explicitly.
    if ! [ -t 0 ] && ! have_tty; then
      die "没有终端可以输入密码；请设置 OPENCODE_SERVER_PASSWORD 后重试"
    fi
    if ! read -rsp "  opencode server 密码（Basic auth）: " OPENCODE_SERVER_PASSWORD < /dev/tty; then
      die "读不到终端输入；请设置 OPENCODE_SERVER_PASSWORD 后重试"
    fi
    printf '\n'
    [ -n "$OPENCODE_SERVER_PASSWORD" ] || die "密码不能为空"
  fi
  export OPENCODE_SERVER_PASSWORD

  # The wizard verifies the server, so it has to be up first.
  server_up() {
    curl -sf -u "opencode:${OPENCODE_SERVER_PASSWORD}" "${SERVER_URL}/api/session/active" >/dev/null 2>&1
  }
  # Distinguish "nothing there" from "a server with another password": the
  # latter cannot be fixed by starting a second server on the same port.
  local code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' \
    -u "opencode:${OPENCODE_SERVER_PASSWORD}" "${SERVER_URL}/api/session/active" 2>/dev/null || true)"
  if [ "$code" = "401" ]; then
    die "已经有 opencode server 在 ${SERVER_URL}，但密码不对。请输入它启动时的 OPENCODE_SERVER_PASSWORD，或先停掉它再重试"
  fi
  if [ -z "$code" ] || [ "$code" = "000" ]; then
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

  # The wizard writes the Feishu credentials; the server address and password
  # are the installer's, so make sure the saved file matches what was asked
  # (and does not fall back to 4096 when another port was chosen).
  local env_file
  env_file="$(ls -t "$CONFIG_DIR"/.env.* 2>/dev/null | head -1 || true)"
  if [ -n "$env_file" ]; then
    local tmp="$env_file.tmp"
    grep -v -E '^OPENCODE_SERVER_(URL|USERNAME|PASSWORD)=' "$env_file" > "$tmp" || true
    {
      printf 'OPENCODE_SERVER_URL=%s\n' "$SERVER_URL"
      printf 'OPENCODE_SERVER_USERNAME=opencode\n'
      printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$OPENCODE_SERVER_PASSWORD"
    } >> "$tmp"
    mv "$tmp" "$env_file"
    chmod 600 "$env_file"
    ok "已保存: $SERVER_URL（密码已写入 $(basename "$env_file")）"
  fi

  chmod 600 "$CONFIG_DIR"/.env.* 2>/dev/null || true
  ok "飞书配置完成"
}

configure() {
  local existing_env
  existing_env="$(find_env_file)"
  if [ -n "$existing_env" ]; then
    ok "已存在配置: $existing_env"
    return 0
  fi
  if write_env_from_environment; then
    return 0
  fi
  if ! [ -t 0 ] && ! have_tty; then
    die "没有终端可交互：请设置 FEISHU_APP_ID / FEISHU_APP_SECRET / OPENCODE_SERVER_PASSWORD"
  fi
  run_wizard
}

# Read the app's scopes and callback subscriptions back from Feishu, so a
# half-configured app is reported instead of failing later as "no reply".
check_feishu() {
  local env_file app_id="" app_secret="" domain="feishu"
  env_file="$(find_env_file)"
  app_id="${FEISHU_APP_ID:-}"
  app_secret="${FEISHU_APP_SECRET:-}"
  if [ -n "$env_file" ]; then
    [ -n "$app_id" ] || app_id="$(sed -n 's/^FEISHU_APP_ID=//p' "$env_file" | tail -1 | tr -d '"\r')"
    [ -n "$app_secret" ] || app_secret="$(sed -n 's/^FEISHU_APP_SECRET=//p' "$env_file" | tail -1 | tr -d '"\r')"
    domain="$(sed -n 's/^FEISHU_DOMAIN=//p' "$env_file" | tail -1 | tr -d '"\r')"
    [ -n "$domain" ] || domain="feishu"
  fi
  [ -n "$app_id" ] && [ -n "$app_secret" ] || return 0

  local base="https://open.feishu.cn"
  [ "$domain" = "lark" ] && base="https://open.larksuite.com"

  say "检查飞书应用配置"
  local token
  token="$(curl -s -m 10 -X POST "$base/open-apis/auth/v3/tenant_access_token/internal" \
    -H 'Content-Type: application/json' \
    -d "{\"app_id\":\"$app_id\",\"app_secret\":\"$app_secret\"}" \
    | grep -o '"tenant_access_token":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ -z "$token" ]; then
    warn "读不到 tenant token（凭据或网络问题），跳过检查"
    return 0
  fi

  local info
  info="$(curl -s -m 10 "$base/open-apis/application/v6/applications/$app_id?lang=zh_cn" \
    -H "Authorization: Bearer $token" || true)"
  if printf '%s' "$info" | grep -q '"code":[1-9]'; then
    warn "读不到应用配置（应用可能缺少 application:application:self_manage），跳过检查"
    return 0
  fi

  local scopes callbacks missing="" scope
  scopes="$(printf '%s' "$info" | grep -o '"scope":"[^"]*"' | cut -d'"' -f4 || true)"
  callbacks="$(printf '%s' "$info" | grep -o '"subscribed_callbacks":\[[^]]*\]' || true)"
  for scope in \
    im:message:send_as_bot im:message:update im:message.p2p_msg:readonly \
    im:message.group_at_msg:readonly im:resource cardkit:card:write; do
    printf '%s\n' "$scopes" | grep -qx "$scope" || missing="$missing $scope"
  done
  if [ -n "$missing" ]; then
    warn "缺少权限:$missing"
    note "  开发配置 → 权限管理 里添加后，重新发布版本"
  else
    ok "应用权限齐全"
  fi
  if printf '%s' "$callbacks" | grep -q 'card.action.trigger'; then
    ok "卡片回调已订阅（card.action.trigger）"
  else
    warn "未订阅卡片回调 card.action.trigger（点按钮会报 200340）"
  fi
  note "事件订阅 im.message.receive_v1（长连接）无法通过 API 检查，请在后台确认"
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
    if [ "${REPO_UPDATED:-0}" = "1" ]; then
      say "代码已更新，空闲时重启服务"
      restart_bridge
      ok "服务已重启"
    else
      ok "服务已在运行（改动代码后用 $REPO/scripts/restart-when-idle.sh 重启）"
    fi
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
  check_feishu
  install_service

  printf '\n'
  say "完成。"
  printf '  日志:  %s\n' "$STATE_DIR/bridge.log"
  printf '  状态:  systemctl --user status opencode-lark\n'
  printf '  重启:  %s/scripts/restart-when-idle.sh\n' "$REPO"
  printf '  重配:  bash %s/install.sh config\n' "$REPO"
  printf '  更新:  bash %s/install.sh update\n' "$REPO"
  printf '  卸载:  bash %s/install.sh remove\n\n' "$REPO"
  printf '%s\n' "${BOLD}飞书后台还需要（一次性）：${NC}"
  printf '  1. 事件订阅（长连接）: im.message.receive_v1\n'
  printf '  2. 发布版本，并把机器人拉进群\n'
  printf '%s\n' "${DIM}  保存长连接设置前服务必须在跑。${NC}"
}

do_config() {
  resolve_repo || true
  if [ ! -f "$REPO/src/index.ts" ]; then
    die "找不到仓库（$REPO），先运行 install.sh install"
  fi
  require_bun
  require_opencode

  local existing_env before="" new_file new_name old
  existing_env="$(find_env_file)"
  if [ -n "$existing_env" ]; then
    if [ -t 0 ] || have_tty; then
      local answer=""
      read -rp "重新配置会替换现有飞书凭据（$existing_env），继续？[y/N]: " answer < /dev/tty || answer=""
      case "$answer" in y|Y|yes|YES) ;; *) die "已取消" ;; esac
    fi
    # Remember what is there; only the file the wizard writes survives, so a
    # cancelled wizard changes nothing at all.
    before="$(cd "$CONFIG_DIR" && ls -1 .env.* 2>/dev/null || true)"
  fi

  if ! run_wizard; then
    die "配置向导没有完成"
  fi

  new_file="$(ls -t "$CONFIG_DIR"/.env.* 2>/dev/null | head -1 || true)"
  [ -n "$new_file" ] || die "向导结束了，但没有生成配置文件"
  new_name="$(basename "$new_file")"
  for old in $before; do
    if [ "$old" != "$new_name" ]; then
      rm -f "$CONFIG_DIR/$old"
      note "已删除旧应用的配置: $old"
    fi
  done

  check_feishu

  if [ "${OPENCODE_LARK_NO_SERVICE:-0}" = "1" ] || ! has_systemd; then
    note "跳过服务重启；手动重启：cd $REPO && $BUN run src/index.ts"
    return 0
  fi
  if systemctl --user is-active --quiet opencode-lark; then
    say "重启服务以加载新配置"
    restart_bridge
  else
    systemctl --user start opencode-lark
    ok "服务已启动"
  fi
}

do_update() {
  resolve_repo || true
  if [ ! -f "$REPO/src/index.ts" ]; then
    die "找不到仓库（$REPO），先运行 install.sh install"
  fi
  require_bun

  update_clone
  install_deps

  if [ "${OPENCODE_LARK_NO_SERVICE:-0}" = "1" ] || ! has_systemd; then
    note "跳过服务重启；手动重启：cd $REPO && $BUN run src/index.ts"
    return 0
  fi
  if ! systemctl --user is-active --quiet opencode-lark; then
    note "服务未运行，跳过重启（用 systemctl --user start opencode-lark 启动）"
    return 0
  fi

  say "空闲时重启服务"
  restart_bridge
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
    resolve_repo || true
    if [ -d "$REPO/data" ]; then
      rm -rf "$REPO/data"
    fi
    ok "配置和数据已删除"
  else
    note "配置保留在 $CONFIG_DIR（加 --purge 一并删除）"
    resolve_repo || true
    if [ -d "$REPO/data" ]; then
      note "会话映射保留在 $REPO/data"
    fi
  fi

  note "代码目录没有删除；需要的话手动 rm -rf ${REPO:-$HOME/opencode-lark}"
  note "如果不再需要，注销后自启也一并失效（loginctl disable-linger $USER 可立即关闭）"
}

case "${1:-install}" in
  install) do_install ;;
  config)  do_config ;;
  update)  do_update ;;
  remove)  do_remove "$@" ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
