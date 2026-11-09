#!/usr/bin/env bash
# 量 E2E 的記憶體尖峰與耗時。用法（在 worktree 根目錄，必須經排程）：
#   HEAVY_COST=3 scripts/heavy.sh measure-e2e scripts/measure/measure-e2e.sh <flows|visual> [Playwright 參數...]
# 每秒取一次 run-e2e.sh 的整棵行程樹（PGlite、next dev、Playwright、chromium）的 RSS 總和，結束後印出尖峰與耗時。
# 只算自己這棵行程樹，不受其他對話的 node 行程影響。RSS 會重複計算共用頁面，所以尖峰是保守的上限。
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
TMP=${MEASURE_TMP:-${TMPDIR:-/tmp}}
LOG=$TMP/measure-e2e.log
SAMPLES=$TMP/measure-e2e.samples
: > "$SAMPLES"
t0=$(date +%s)
scripts/e2e/run-e2e.sh "$@" > "$LOG" 2>&1 &
ROOT=$!
( while kill -0 "$ROOT" 2>/dev/null; do
    ps -axo pid=,ppid=,rss= | awk -v root="$ROOT" '
      { parent[$1] = $2; rss[$1] = $3 }
      END {
        for (p in parent) { q = p; while (q != "" && q != 0 && q != 1) { if (q == root) { sum += rss[p]; break }; q = parent[q] } }
        printf "%d\n", sum / 1024
      }' >> "$SAMPLES"
    sleep 1
  done ) &
SP=$!
wait "$ROOT"; rc=$?
wait "$SP" 2>/dev/null
echo "E2E 結束碼：$rc"
echo "耗時：$(( $(date +%s) - t0 )) 秒"
echo "行程樹 RSS 總和尖峰：$(sort -n "$SAMPLES" | tail -1) MB（取樣 $(wc -l < "$SAMPLES") 次，log：$LOG）"
grep -E "passed|failed|LISTEN" "$LOG"
exit $rc
