#!/usr/bin/env bash
# API 冒煙的外殼：啟動 PGlite socket 與 next dev，跑一支 Node 冒煙腳本，結束後關掉兩者並清理。
# 整段包成一個腳本，dev server 不會留在背景。
#
# 用法（在 worktree 根目錄，必須經排程）：
#   scripts/heavy.sh smoke scripts/smoke/run-smoke.sh <dev server port> <冒煙腳本.mjs> [pg port]
#
# 冒煙腳本從環境變數 BASE_URL 取得 dev server 位址（例如 http://127.0.0.1:3192）。
# 每個子對話用不同的 port，避免撞到別人的 dev server。pg port 預設 54000 加上 dev port 的後三位數。
# 輸出存檔：把這個腳本的 stdout 轉向，例如 `... | tee <輸出檔>`。
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
if [ $# -lt 2 ]; then echo "用法：run-smoke.sh <dev server port> <冒煙腳本.mjs> [pg port]" >&2; exit 64; fi
PORT=$1; SMOKE=$2
PG_PORT=${3:-$((54000 + PORT % 1000))}
TMP=${SMOKE_TMP:-${TMPDIR:-/tmp}}
PG_LOG=$TMP/smoke-pg-$PORT.log
NEXT_LOG=$TMP/smoke-next-$PORT.log
DIST=.next-smoke-$PORT
: > "$PG_LOG"; : > "$NEXT_LOG"

cleanup() {
  # 只殺自己 port 的 LISTEN 行程與自己啟動的行程
  for p in "$PORT" "$PG_PORT"; do
    pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null)
    [ -n "$pids" ] && kill $pids 2>/dev/null
  done
  [ -n "${NEXT_PID:-}" ] && kill "$NEXT_PID" 2>/dev/null
  [ -n "${PG_PID:-}" ] && kill "$PG_PID" 2>/dev/null
  sleep 2
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

PG_PORT=$PG_PORT node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/smoke/pg-socket-server.mjs > "$PG_LOG" 2>&1 &
PG_PID=$!
wait_for "$PG_LOG" ready 120 || exit 1

NEXT_DIST_DIR=$DIST DATABASE_URL="postgres://app_rw:x@127.0.0.1:$PG_PORT/postgres" PG_POOL_MAX=1 \
  MAILER_ADAPTER=${MAILER_ADAPTER:-log} SEED_OWNER_EMAIL=${SEED_OWNER_EMAIL:-owner-smoke@example.com} \
  npx next dev --webpack -p "$PORT" > "$NEXT_LOG" 2>&1 &
NEXT_PID=$!
wait_for "$NEXT_LOG" "Ready in" 180 || exit 1

BASE_URL="http://127.0.0.1:$PORT" node "$SMOKE"
exit $?
