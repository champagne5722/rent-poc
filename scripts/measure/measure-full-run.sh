#!/usr/bin/env bash
# 量完整 vitest run 的記憶體尖峰。用法：scripts/heavy.sh measure scripts/measure/measure-full-run.sh <worktree> [額外 vitest 參數...]
# 預設參數：--maxWorkers=2 --testTimeout=60000 --hookTimeout=60000。
# 背景每 2 秒取所有 node 行程的 RSS 總和，前景跑 vitest，結束後印出尖峰、耗時與測試數。
# 注意：RSS 總和包含其他對話的 node 行程。要量準，先確認機器上沒有別的重命令。
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd "$1" || exit 2; shift
ARGS=("$@"); [ ${#ARGS[@]} -eq 0 ] && ARGS=(--maxWorkers=2 --testTimeout=60000 --hookTimeout=60000)
TMP=${MEASURE_TMP:-${TMPDIR:-/tmp}}
LOG=$TMP/measure-full-run.log
SAMPLES=$TMP/measure-full-run.samples
: > "$SAMPLES"
( while true; do
    ps -axo rss,comm | awk '/node/ {s+=$1} END {printf "%d\n", s/1024}' >> "$SAMPLES"
    sleep 2
  done ) &
SP=$!
trap 'kill $SP 2>/dev/null' EXIT
t0=$(date +%s)
npx vitest run "${ARGS[@]}" > "$LOG" 2>&1
rc=$?
kill $SP 2>/dev/null; wait $SP 2>/dev/null
peak=$(sort -n "$SAMPLES" | tail -1)
base=$(sort -n "$SAMPLES" | head -1)
echo "vitest 結束碼：$rc"
echo "耗時：$(( $(date +%s) - t0 )) 秒"
echo "node RSS 總和尖峰：${peak} MB（取樣最低 ${base} MB，取樣 $(wc -l < "$SAMPLES") 次）"
grep -E "^ +(Test Files|Tests) " "$LOG"
if [ $rc -ne 0 ]; then echo "--- 失敗摘要（log：$LOG）"; grep -E "FAIL|Error:" "$LOG" | head -20; fi
exit $rc
