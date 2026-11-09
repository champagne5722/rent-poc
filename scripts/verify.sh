#!/usr/bin/env bash
# 用法：scripts/verify.sh（在要驗證的 worktree 根目錄執行，或 npm run verify）
# 依序跑 typecheck、完整 test、lint，並檢查被 .gitignore 排除的檔案。全部通過才回傳 0。
# 整段只佔一個排程名額（成本 4 GB），內部的 npm script 因為重入不再排隊。
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
here=$(cd "$(dirname "$0")" && pwd)
if [ -z "${HEAVY_HELD:-}" ] && [ "${CI:-}" != "true" ]; then
  exec "$here/heavy.sh" verify "$here/verify.sh" "$@"
fi
cd "$here/.." || exit 2

# 被 .gitignore 排除的檔案不會進版控。測試若讀到它們，在這個 worktree 會過、在別處會失敗（MIL-88 的 .pem）。
ignored=$(git status --short --ignored src db scripts docs 2>/dev/null | grep '^!!')
if [ -n "$ignored" ]; then
  echo "IGNORED FILES（不會進版控，確認測試沒有依賴它們）："
  echo "$ignored"
  ign=1
else
  ign=0
fi

echo "== typecheck"; npm run --silent typecheck 2>&1 | tail -5; tsc_rc=${PIPESTATUS[0]}
echo "== test"; npm test --silent -- --testTimeout=60000 --hookTimeout=60000 2>&1 | grep -E "Test Files|Tests |FAIL"; test_rc=${PIPESTATUS[0]}
echo "== lint"; npm run --silent lint -- --max-warnings=10 2>&1 | tail -2; lint_rc=${PIPESTATUS[0]}
echo "RESULT typecheck=$tsc_rc test=$test_rc lint=$lint_rc ignored=$ign head=$(git rev-parse --short HEAD)"
[ "$tsc_rc" = 0 ] && [ "$test_rc" = 0 ] && [ "$lint_rc" = 0 ] && [ "$ign" = 0 ]
