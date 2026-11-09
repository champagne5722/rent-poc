#!/bin/sh
# PreToolUse hook 的入口。找不到 node 時放行（防呆工具不該卡住工作）。
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "$0")/guard-heavy.mjs"
