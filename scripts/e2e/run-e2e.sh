#!/usr/bin/env bash
# Playwright E2E 的外殼：啟動 PGlite socket 與 next dev，跑 Playwright，結束後關掉兩者並清理。
# 整段包成一個腳本，dev server 與瀏覽器都不會留在背景。寫法參考 scripts/smoke/run-smoke.sh。
#
# 用法（在 worktree 根目錄，必須經排程；日常請用 npm run e2e 與 npm run e2e:visual）：
#   scripts/heavy.sh e2e scripts/e2e/run-e2e.sh <flows|visual|baseline> [Playwright 參數...]
#
# 環境變數：
#   E2E_PORT      dev server port，預設 3410。
#   E2E_PG_PORT   PGlite port，預設 54000 加上 dev port 的後三位數（3410 對應 54410）。
#   E2E_TMP       dev server 與 PGlite 的 log 目錄，預設 $TMPDIR。
#
# 簽署走 mock 模式：外殼清掉 DOTTEDSIGN_CLIENT_ID 與 DOTTEDSIGN_CLIENT_SECRET，不呼叫點點簽。
# 登入走 email 驗證碼：Mailer 用 log adapter，測試從 /demo/otp 取碼。應用程式碼沒有為測試開後門。
# 資料庫是這次啟動的記憶體 PGlite，每次執行都是全新的，不依賴既有資料。
#
# baseline（MIL-170）專用：平台營運者沒有自助註冊，由環境變數建立，所以外殼替 dev server 設
# PLATFORM_OPERATOR_EMAILS（BASELINE_OPERATOR_EMAIL，預設 e2e-operator@example.com）。
# flows 也會設（MIL-201 的出租權源核對流程要平台營運者登入），visual 的環境不變。baseline 要開 CDP port 給 impeccable detect，
# port 由 BASELINE_CDP_PORT 指定（預設 9333），瀏覽器由測試自己啟動，結束時跟著測試關閉。
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
if [ $# -lt 1 ]; then echo "用法：run-e2e.sh <flows|visual|baseline> [Playwright 參數...]" >&2; exit 64; fi
PROJECT=$1; shift
case "$PROJECT" in flows|visual|baseline) ;; *) echo "第一個參數必須是 flows、visual 或 baseline，收到「$PROJECT」" >&2; exit 64 ;; esac

PORT=${E2E_PORT:-3410}
PG_PORT=${E2E_PG_PORT:-$((54000 + PORT % 1000))}
TMP=${E2E_TMP:-${TMPDIR:-/tmp}}
PG_LOG=$TMP/e2e-pg-$PORT.log
NEXT_LOG=$TMP/e2e-next-$PORT.log
DIST=.next-e2e-$PORT
: > "$PG_LOG"; : > "$NEXT_LOG"

cleanup() {
  # 只殺自己 port 的 LISTEN 行程與自己啟動的行程
  for p in "$PORT" "$PG_PORT"; do
    pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null)
    [ -n "$pids" ] && kill $pids 2>/dev/null
  done
  [ -n "${NEXT_PID:-}" ] && kill "$NEXT_PID" 2>/dev/null
  [ -n "${PG_PID:-}" ] && kill "$PG_PID" 2>/dev/null
  # 收掉子行程，bash 才不會在輸出裡印「Terminated」
  { wait; } 2>/dev/null
  sleep 1
  rm -rf "$DIST"
  echo "LISTEN $PORT: $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | wc -l | tr -d ' ')"
}
trap cleanup EXIT

wait_for() { # 檔案 關鍵字 秒數
  local n=0
  until grep -q "$2" "$1" 2>/dev/null; do
    sleep 2; n=$((n + 2))
    if [ "$n" -ge "$3" ]; then echo "等不到「$2」（$1）" >&2; tail -20 "$1" >&2; return 1; fi
  done
}

# 前一次異常結束留下的同 port 行程會讓這次連到舊的資料庫，所以先確認 port 是空的
for p in "$PORT" "$PG_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "port $p 已被占用，停止" >&2; trap - EXIT; exit 65; fi
done

PG_PORT=$PG_PORT node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/smoke/pg-socket-server.mjs > "$PG_LOG" 2>&1 &
PG_PID=$!
wait_for "$PG_LOG" ready 120 || exit 1

OPERATOR_ENV=""
[ "$PROJECT" = baseline ] || [ "$PROJECT" = flows ] && OPERATOR_ENV="PLATFORM_OPERATOR_EMAILS=${BASELINE_OPERATOR_EMAIL:-e2e-operator@example.com}"
env -u DOTTEDSIGN_CLIENT_ID -u DOTTEDSIGN_CLIENT_SECRET $OPERATOR_ENV \
  NEXT_DIST_DIR=$DIST DATABASE_URL="postgres://app_rw:x@127.0.0.1:$PG_PORT/postgres" PG_POOL_MAX=1 \
  MAILER_ADAPTER=log NEXT_TELEMETRY_DISABLED=1 \
  npx next dev --webpack -p "$PORT" > "$NEXT_LOG" 2>&1 &
NEXT_PID=$!
wait_for "$NEXT_LOG" "Ready in" 180 || exit 1

# 用 localhost：Next 預設只放行 localhost 的 dev 資源，127.0.0.1 會被擋
BASE_URL="http://localhost:$PORT" npx playwright test --project="$PROJECT" "$@"
exit $?
