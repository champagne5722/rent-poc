#!/usr/bin/env bash
# 用法：npm run test:pg（在 worktree 根目錄執行）
# 在真實 PostgreSQL 18 上跑所有 `*.pg.test.ts`，並確認它們真的執行了、沒有被跳過（MIL-89，驗收條件 14）。
# 需要 Docker。CI 的 check 工作跑的是同一組測試與同一個檢查（scripts/ci/check-pg-tests-ran.mjs）。
#
# 做法：
# 1. 已設定 TEST_DATABASE_URL 時，直接用它，不啟動容器。
# 2. 沒有設定時，啟動自己的容器（預設名稱 rentpoc-pg-test，port 54399），跑完刪除。
#    容器名稱不同於 rentpoc-pg-verify（54329，驗證者共用），不會碰到別人的容器。
# 3. 容器、命令的成本都經過 scripts/heavy.sh 排程（4 GB）。
#
# 環境變數：
#   TEST_DATABASE_URL  指向已存在的 PostgreSQL 管理者連線。設了就不啟動容器。
#   PG_TEST_CONTAINER  容器名稱，預設 rentpoc-pg-test
#   PG_TEST_PORT       容器對外 port，預設 54399
#   PG_TEST_KEEP=1     跑完保留容器（下次執行重用，加快啟動）
#   PG_TEST_MIN        通過數量下限，預設 100
# 之後新增 `*.pg.test.ts` 的人不用改這個檔：它用檔名 `.pg.test.ts` 當 vitest 的篩選字串。
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
here=$(cd "$(dirname "$0")" && pwd)
if [ -z "${HEAVY_HELD:-}" ] && [ "${CI:-}" != "true" ]; then
  HEAVY_COST=${HEAVY_COST:-4} exec "$here/heavy.sh" test-pg "$here/pg-test.sh" "$@"
fi
cd "$here/.." || exit 2

name=${PG_TEST_CONTAINER:-rentpoc-pg-test}
port=${PG_TEST_PORT:-54399}
started=0
cleanup() {
  if [ "$started" = 1 ] && [ "${PG_TEST_KEEP:-}" != 1 ]; then
    docker rm -f "$name" >/dev/null 2>&1
    echo "已刪除容器 $name"
  fi
}
trap cleanup EXIT

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "找不到可用的 Docker。請啟動 Docker，或設定 TEST_DATABASE_URL 指向一個 PostgreSQL 18。" >&2
    exit 69
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    echo "重用執行中的容器 $name"
  else
    docker rm -f "$name" >/dev/null 2>&1
    docker run --name "$name" -d -p "$port:5432" -e POSTGRES_PASSWORD=pw postgres:18 >/dev/null || exit 70
    started=1
  fi
  for _ in $(seq 1 60); do
    docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 || { echo "容器 $name 60 秒內沒有就緒" >&2; exit 71; }
  export TEST_DATABASE_URL="postgres://postgres:pw@localhost:$port/postgres"
fi

report=$(mktemp -t vitest-pg-report.XXXXXX)
npx vitest run .pg.test.ts --testTimeout=60000 --hookTimeout=60000 \
  --reporter=default --reporter=json --outputFile.json="$report"
test_rc=$?
node scripts/ci/check-pg-tests-ran.mjs "$report" --min "${PG_TEST_MIN:-100}"
check_rc=$?
rm -f "$report"
echo "RESULT pg-test=$test_rc ran-check=$check_rc"
[ "$test_rc" = 0 ] && [ "$check_rc" = 0 ]
