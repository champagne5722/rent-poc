#!/usr/bin/env bash
# heavy.sh 的測試。執行：scripts/heavy.test.sh（或 npm run test:scripts）
# 全程用暫存的名額目錄、極小的預算與 sleep，不跑任何真正的重命令。
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
HEAVY="$HERE/heavy.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/heavy-test.XXXXXX")
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$TMP"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   $1"; }
bad() { failed=$((failed + 1)); echo "FAIL $1"; shift; [ $# -gt 0 ] && echo "     $*"; }
expect_eq() { # 名稱 預期 實際
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "預期「$2」，實際「$3」"; fi
}

# 每個案例用自己的名額目錄，互不影響。
new_dir() { mktemp -d "$TMP/case.XXXXXX"; }
# 乾淨的環境：沒有 CI、沒有外層排程，記憶體檢查關閉，輪詢 1 秒。
heavy() {
  env -u CI -u HEAVY_HELD -u HEAVY_COST -u HEAVY_BUDGET -u HEAVY_TIMEOUT -u HEAVY_QUEUE_TIMEOUT \
    HEAVY_FREE_WAIT=0 HEAVY_FREE_MIN=0 HEAVY_POLL=1 "$@"
}
cost_of() { heavy HEAVY_DIR="$(new_dir)" HEAVY_PRINT_COST=1 "$HEAVY" t "$@"; }
cost_with() { local e=$1; shift; heavy HEAVY_DIR="$(new_dir)" HEAVY_PRINT_COST=1 "$e" "$HEAVY" t "$@"; }

# --- 成本表 ---
expect_eq "成本：完整 vitest 4" 4 "$(cost_of vitest run)"
expect_eq "成本：指定目錄的 vitest 3" 3 "$(cost_of vitest run src/lib)"
expect_eq "成本：指定檔案的 vitest 3" 3 "$(cost_of vitest run foo.test.ts)"
expect_eq "成本：eslint 3" 3 "$(cost_of eslint src)"
expect_eq "成本：tsc 1" 1 "$(cost_of tsc --noEmit)"
expect_eq "成本：next build 3" 3 "$(cost_of next build)"
expect_eq "成本：next dev 3" 3 "$(cost_of next dev -p 3192)"
expect_eq "成本：verify.sh 4" 4 "$(cost_of scripts/verify.sh)"
expect_eq "成本：measure-full-run.sh 4" 4 "$(cost_of scripts/measure/measure-full-run.sh /wt)"
expect_eq "成本：npm test 4" 4 "$(cost_of npm test)"
expect_eq "成本：npm test 加路徑 3" 3 "$(cost_of npm test -- src/lib/a.test.ts)"
expect_eq "成本：npm run lint 3" 3 "$(cost_of npm run lint)"
expect_eq "成本：npm run typecheck 1" 1 "$(cost_of npm run typecheck)"
expect_eq "成本：其他命令 3" 3 "$(cost_of echo hi)"
expect_eq "成本：HEAVY_COST 覆寫" 2 "$(cost_with HEAVY_COST=2 vitest run)"
expect_eq "成本：不超過預算" 2 "$(cost_with HEAVY_BUDGET=2 vitest run)"

# --- 基本行為 ---
d=$(new_dir)
heavy HEAVY_DIR="$d" "$HEAVY" t sh -c 'exit 7'
expect_eq "結束碼原樣傳回" 7 $?

heavy HEAVY_DIR="$d" "$HEAVY" >/dev/null 2>&1
expect_eq "沒有命令時回傳 64" 64 $?

out=$(heavy HEAVY_DIR="$d" "$HEAVY" t echo hello)
expect_eq "命令的輸出照常出現" hello "$out"
expect_eq "結束後名額檔被移除" 0 "$(find "$d/slots" -type f 2>/dev/null | wc -l | tr -d ' ')"

# --- 失效名額 ---
d=$(new_dir)
mkdir -p "$d/slots"
sh -c 'exit 0' & dead=$!
wait "$dead"
echo "8 ghost 00:00:00 /nowhere" > "$d/slots/$dead"
out=$(heavy HEAVY_DIR="$d" HEAVY_BUDGET=8 HEAVY_COST=8 HEAVY_QUEUE_TIMEOUT=3 "$HEAVY" t echo alive)
expect_eq "持有者已死的名額自動失效" alive "$out"

# --- CI 直接放行 ---
d=$(new_dir)
mkdir -p "$d/slots"
echo "8 busy 00:00:00 /x" > "$d/slots/$$" # 用本行程的 pid，視為活著且佔滿
out=$(env CI=true HEAVY_DIR="$d" HEAVY_BUDGET=8 HEAVY_COST=8 HEAVY_QUEUE_TIMEOUT=2 "$HEAVY" t echo ci-ran)
expect_eq "CI=true 時不排隊" ci-ran "$out"
expect_eq "CI=true 時結束碼原樣" 5 "$(env CI=true HEAVY_DIR="$d" "$HEAVY" t sh -c 'exit 5'; echo $?)"

# --- 重入 ---
d=$(new_dir)
out=$(heavy HEAVY_DIR="$d" HEAVY_BUDGET=4 HEAVY_COST=4 HEAVY_QUEUE_TIMEOUT=3 \
  "$HEAVY" outer env HEAVY_DIR="$d" HEAVY_BUDGET=4 HEAVY_COST=4 HEAVY_QUEUE_TIMEOUT=3 "$HEAVY" inner echo nested-ok 2>&1)
expect_eq "已在排程內的命令不再排隊" nested-ok "$out"

# --- 排隊：預算滿時第二個命令等第一個結束 ---
d=$(new_dir)
a_end="$d/a_end"
heavy HEAVY_DIR="$d" HEAVY_BUDGET=4 HEAVY_COST=4 "$HEAVY" a sh -c "sleep 3; date +%s > '$a_end'" &
a_pid=$!
for _ in $(seq 1 50); do [ -n "$(ls "$d/slots" 2>/dev/null)" ] && break; sleep 0.1; done
t0=$(date +%s)
b_start=$(heavy HEAVY_DIR="$d" HEAVY_BUDGET=4 HEAVY_COST=4 "$HEAVY" b date +%s 2>/dev/null)
b_waited=$(( $(date +%s) - t0 ))
wait "$a_pid"
if [ -f "$a_end" ] && [ "$b_start" -ge "$(cat "$a_end")" ]; then ok "排隊：第二個命令在第一個結束後才開始"; else bad "排隊：第二個命令在第一個結束後才開始" "b_start=$b_start a_end=$(cat "$a_end" 2>/dev/null)"; fi
if [ "$b_waited" -ge 2 ]; then ok "排隊：第二個命令確實等了（${b_waited} 秒）"; else bad "排隊：第二個命令確實等了" "只等了 ${b_waited} 秒"; fi

# --- 預算夠時兩個命令同時跑 ---
d=$(new_dir)
a_end="$d/a_end"
heavy HEAVY_DIR="$d" HEAVY_BUDGET=8 HEAVY_COST=3 "$HEAVY" a sh -c "sleep 3; date +%s > '$a_end'" &
a_pid=$!
for _ in $(seq 1 50); do [ -n "$(ls "$d/slots" 2>/dev/null)" ] && break; sleep 0.1; done
b_start=$(heavy HEAVY_DIR="$d" HEAVY_BUDGET=8 HEAVY_COST=3 "$HEAVY" b date +%s 2>/dev/null)
wait "$a_pid"
if [ "$b_start" -lt "$(cat "$a_end")" ]; then ok "預算夠時不排隊（3 加 3 不超過 8）"; else bad "預算夠時不排隊" "b_start=$b_start a_end=$(cat "$a_end")"; fi

# --- 排隊逾時回傳 75 ---
d=$(new_dir)
heavy HEAVY_DIR="$d" HEAVY_BUDGET=4 HEAVY_COST=4 "$HEAVY" a sleep 5 &
a_pid=$!
for _ in $(seq 1 50); do [ -n "$(ls "$d/slots" 2>/dev/null)" ] && break; sleep 0.1; done
heavy HEAVY_DIR="$d" HEAVY_BUDGET=4 HEAVY_COST=4 HEAVY_QUEUE_TIMEOUT=2 "$HEAVY" b echo never >/dev/null 2>&1
expect_eq "排隊逾時回傳 75" 75 $?
kill "$a_pid" 2>/dev/null; wait "$a_pid" 2>/dev/null

# --- 命令逾時：回傳 124，整個行程群組收掉 ---
d=$(new_dir)
t0=$(date +%s)
heavy HEAVY_DIR="$d" HEAVY_TIMEOUT=1 "$HEAVY" t sh -c 'sleep 31337 & wait' >/dev/null 2>&1
rc=$?
expect_eq "命令逾時回傳 124" 124 "$rc"
if pgrep -f 'sleep 31337' >/dev/null; then bad "逾時後沒有殘留行程"; pkill -f 'sleep 31337'; else ok "逾時後沒有殘留行程"; fi
if [ $(( $(date +%s) - t0 )) -le 10 ]; then ok "逾時後 10 秒內收完"; else bad "逾時後 10 秒內收完"; fi

# --- 記憶體不足回傳 76（只在有 memory_pressure 的 macOS 測）---
if command -v memory_pressure >/dev/null 2>&1; then
  d=$(new_dir)
  env -u CI -u HEAVY_HELD HEAVY_DIR="$d" HEAVY_FREE_WAIT=0 HEAVY_FREE_MIN=101 "$HEAVY" t echo never >/dev/null 2>&1
  expect_eq "空閒記憶體低於下限回傳 76" 76 $?
fi

echo
echo "通過 $passed，失敗 $failed"
[ "$failed" -eq 0 ]
