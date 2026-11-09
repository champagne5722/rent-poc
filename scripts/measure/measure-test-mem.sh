#!/usr/bin/env bash
# 逐檔量測測試的記憶體尖峰。用法：scripts/heavy.sh measure scripts/measure/measure-test-mem.sh <worktree> <輸出 csv>
# 一次只跑一個測試檔（--maxWorkers=1），每 0.5 秒取所有 node 行程的 RSS 總和，記尖峰。
# 只量指定的檔案：FILES="a.test.ts b.test.ts" scripts/measure/measure-test-mem.sh <worktree> <csv>
# 沒有設 FILES 時量所有測試檔，要跑很久。
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd "$1" || exit 2
OUT=$2
LOG=${MEASURE_LOG:-${TMPDIR:-/tmp}/measure-test-mem.log}
echo "peak_mb,wall_s,tests,pglite,file" > "$OUT"
if [ -n "${FILES:-}" ]; then list=$FILES; else list=$(git ls-files 'src/**/*.test.ts' | sort); fi
for f in $list; do
  ( npx vitest run "$f" --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000 > "$LOG" 2>&1 ) &
  vp=$!; peak=0; t0=$(date +%s)
  while kill -0 $vp 2>/dev/null; do
    rss=$(ps -axo rss,comm | awk '/node/ {s+=$1} END {printf "%d", s/1024}')
    [ "$rss" -gt "$peak" ] && peak=$rss
    sleep 0.5
  done
  tests=$(grep -E "^ +Tests " "$LOG" | grep -oE "[0-9]+ passed" | grep -oE "[0-9]+")
  pg=$(grep -lE "pglite|PGlite|route-test-kit|setupRouteDb|pg-test-kit|createTestDb|testDb" "$f" >/dev/null 2>&1 && echo 1 || echo 0)
  echo "$peak,$(( $(date +%s)-t0 )),${tests:-0},$pg,$f" >> "$OUT"
done
# 注意：測試數欄位為 0 或 1 時，先看 $LOG，量測不檢查測試是否失敗。
