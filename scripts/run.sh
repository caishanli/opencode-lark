#!/bin/sh
# Resolve the bun executable and run it with the given arguments.
#
# bun is often installed to ~/.bun/bin without being added to PATH, which
# breaks `npm start` / `bun run start` in non-interactive shells (CI, Docker,
# systemd, or a plain `bash -c`). This wrapper finds bun in the usual places
# and execs it, so the npm scripts work regardless of the caller's PATH.
set -e

if command -v bun >/dev/null 2>&1; then
  BUN=bun
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
elif [ -n "$BUN_INSTALL" ] && [ -x "$BUN_INSTALL/bin/bun" ]; then
  BUN="$BUN_INSTALL/bin/bun"
else
  echo "error: bun not found." >&2
  echo "  Install it from https://bun.sh and add \$HOME/.bun/bin to your PATH:" >&2
  echo "    export BUN_INSTALL=\"\$HOME/.bun\"" >&2
  echo "    export PATH=\"\$BUN_INSTALL/bin:\$PATH\"" >&2
  exit 127
fi

exec "$BUN" "$@"
