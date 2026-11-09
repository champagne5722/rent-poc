#!/usr/bin/env bash
# 用法：scripts/heavy.sh <標籤> <命令...>
# 整台機器的「記憶體預算」排程。vitest、eslint、tsc、next dev、next build 與冒煙腳本都必須經過它。
# package.json 的 test、lint、typecheck、verify、build 已經包好，直接用 npm run 即可。
#
# 為什麼：開發機只有 16 GB。2026-11-09 多個測試同時執行，把記憶體用完，整台機器停止回應。
# 做法參考 Bazel 的 --local_resources 與 make jobserver：每個命令有成本（GB），總和不超過預算才放行。
#
# 成本（GB，MIL-163 之後的實測加餘裕）：
#   完整 vitest（沒有指定路徑）、verify.sh   4   實測尖峰 3.0 GB（2 個 worker）
#   指定路徑的 vitest                        3   PGlite 測試檔每檔 1.1 到 1.5 GB，2 個 worker
#   eslint                                   3   實測 2.5 GB
#   next dev、next build、冒煙腳本           3   沒實測，保守估
#   tsc                                      1   實測 0.9 GB
#   其他                                     3
# 預算預設 8 GB。命令的成本由命令字串判斷，也能用 HEAVY_COST=<整數> 覆寫。
#
# 行為：
# - CI=true 時直接執行命令，不排隊。
# - 命令已經在排程內執行時（環境變數 HEAVY_HELD 指向還活著的排程行程），內層直接執行，不再排隊也不重複計成本。
# - 預算不夠就等，每 30 秒印一行。等超過 8 分鐘回傳 75，呼叫端稍後再試，不要繞過。
# - 放行前，系統空閒記憶體低於 35% 就再等，最多 2 分鐘。仍低於 25% 回傳 76，停下來回報。
#   這項檢查只在有 memory_pressure 指令的 macOS 上進行。
# - 命令在自己的行程群組執行。結束、被中斷或超過逾時（預設 1500 秒）時，整個群組一起收掉，
#   不留殘留的子行程（例如沒關的 dev server）。逾時回傳 124。
# - 持有者的行程不在了，它佔的名額自動失效。
#
# 環境變數：
#   HEAVY_DIR            名額目錄。預設 ${XDG_STATE_HOME:-$HOME/.local/state}/rent-poc/heavy，所有 worktree 共用。
#   HEAVY_BUDGET         預算（GB），預設 8
#   HEAVY_COST           覆寫這次命令的成本
#   HEAVY_TIMEOUT        命令逾時（秒），預設 1500
#   HEAVY_QUEUE_TIMEOUT  排隊上限（秒），預設 480
#   HEAVY_POLL           排隊時的輪詢間隔（秒），預設 5
#   HEAVY_FREE_WAIT      空閒記憶體百分比低於這個值就再等，預設 35
#   HEAVY_FREE_MIN       空閒記憶體百分比低於這個值就拒絕執行，預設 25
#   HEAVY_PRINT_COST=1   只印出成本就結束（測試用）
set -u

if [ $# -lt 2 ]; then echo "用法：heavy.sh <標籤> <命令...>" >&2; exit 64; fi
label=$1; shift
cmd="$*"

BUDGET=${HEAVY_BUDGET:-8}
TIMEOUT=${HEAVY_TIMEOUT:-1500}
QUEUE_TIMEOUT=${HEAVY_QUEUE_TIMEOUT:-480}
POLL=${HEAVY_POLL:-5}
FREE_WAIT=${HEAVY_FREE_WAIT:-35}
FREE_MIN=${HEAVY_FREE_MIN:-25}
DIR=${HEAVY_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/rent-poc/heavy}
SLOTS=$DIR/slots
MUTEX=$DIR/mutex

cost=${HEAVY_COST:-}
if [ -z "$cost" ]; then
  has_path=0
  if printf '%s\n' "$cmd" | grep -qE '(^| )(src/|[^ ]+\.test\.ts)'; then has_path=1; fi
  case "$cmd" in
    *verify.sh*|*measure-full-run*|*"npm run verify"*) cost=4 ;;
    *vitest*|*"npm test"*|*"npm run test"*) if [ $has_path -eq 1 ]; then cost=3; else cost=4; fi ;;
    *eslint*|*"npm run lint"*) cost=3 ;;
    *"next dev"*|*"next build"*|*"npm run build"*|*smoke*) cost=3 ;;
    *tsc*|*"npm run typecheck"*) cost=1 ;;
    *) cost=3 ;;
  esac
fi
if [ "$cost" -gt "$BUDGET" ]; then cost=$BUDGET; fi

if [ "${HEAVY_PRINT_COST:-}" = "1" ]; then echo "$cost"; exit 0; fi

# 放行 1：CI
if [ "${CI:-}" = "true" ]; then exec "$@"; fi
# 放行 2：已在排程內
if [ -n "${HEAVY_HELD:-}" ] && kill -0 "$HEAVY_HELD" 2>/dev/null; then exec "$@"; fi

free_pct() {
  command -v memory_pressure >/dev/null 2>&1 || return 0
  memory_pressure 2>/dev/null | awk -F': ' '/free percentage/ {gsub("%","",$2); print $2}'
}

mkdir -p "$SLOTS"
lock() {
  local n=0
  while ! mkdir "$MUTEX" 2>/dev/null; do
    # mutex 只在加總時短暫持有。超過 20 秒視為殘留。
    n=$((n + 1)); if [ $n -gt 100 ]; then rmdir "$MUTEX" 2>/dev/null; n=0; fi
    sleep 0.2
  done
}
unlock() { rmdir "$MUTEX" 2>/dev/null; }

used() {  # 清掉失效的名額，印出目前佔用的總成本
  local total=0 f pid c
  for f in "$SLOTS"/*; do
    [ -f "$f" ] || continue
    pid=${f##*/}
    if kill -0 "$pid" 2>/dev/null; then
      c=$(awk 'NR==1 {print $1}' "$f" 2>/dev/null)
      total=$((total + ${c:-0}))
    else
      rm -f "$f"
    fi
  done
  echo "$total"
}

holders() { cat "$SLOTS"/* 2>/dev/null | awk '{print $2"("$1")"}' | tr '\n' ' '; }

waited=0
next_report=0
while true; do
  lock; u=$(used)
  if [ $((u + cost)) -le "$BUDGET" ]; then
    echo "$cost $label $(date '+%H:%M:%S') $(pwd)" > "$SLOTS/$$"; unlock; break
  fi
  unlock
  if [ "$waited" -ge "$next_report" ]; then
    echo "heavy.sh：「$label」要 ${cost} GB，已用 ${u}/${BUDGET} GB，已等 ${waited} 秒。佔用者：$(holders)" >&2
    next_report=$((next_report + 30))
  fi
  sleep "$POLL"; waited=$((waited + POLL))
  if [ "$waited" -ge "$QUEUE_TIMEOUT" ]; then
    echo "heavy.sh：等了 ${waited} 秒仍沒有預算。稍後再試，不要繞過。" >&2
    exit 75
  fi
done

child=""
cleanup() {
  [ -n "$child" ] && kill -TERM -- -"$child" 2>/dev/null
  rm -f "$SLOTS/$$"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# 系統空閒記憶體太低時再等一下，最多 2 分鐘。
i=0
while [ $i -lt 24 ]; do
  f=$(free_pct); [ -z "$f" ] && break
  [ "$f" -ge "$FREE_WAIT" ] && break
  [ $i -eq 0 ] && echo "heavy.sh：系統空閒記憶體 ${f}%，等它回到 ${FREE_WAIT}%" >&2
  sleep 5; i=$((i + 1))
done
f=$(free_pct)
if [ -n "$f" ] && [ "$f" -lt "$FREE_MIN" ]; then
  echo "heavy.sh：系統空閒記憶體只有 ${f}%，不執行「$label」。回報主控。" >&2
  exit 76
fi

# 用 setsid 讓命令成為新行程群組的組長（pgid 等於 child），結束時能整組收掉。
# 有 HEAVY_HELD 的子行程遇到內層的 heavy.sh 時直接執行，不再排隊。
HEAVY_HELD=$$ perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' -- "$@" &
child=$!
# 逾時由主行程自己數，不另開計時行程。每 0.25 秒檢查一次。
timed_out=0; ticks=0
while kill -0 "$child" 2>/dev/null; do
  sleep 0.25; ticks=$((ticks + 1))
  if [ $((ticks / 4)) -ge "$TIMEOUT" ]; then
    echo "heavy.sh：「$label」超過 ${TIMEOUT} 秒，強制結束" >&2
    timed_out=1
    kill -TERM -- -"$child" 2>/dev/null
    n=0; while [ $n -lt 20 ] && kill -0 "$child" 2>/dev/null; do sleep 0.25; n=$((n + 1)); done
    kill -KILL -- -"$child" 2>/dev/null
    break
  fi
done
wait "$child" 2>/dev/null; rc=$?
[ $timed_out -eq 1 ] && rc=124
exit $rc
