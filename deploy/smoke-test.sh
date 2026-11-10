#!/usr/bin/env bash
# 映像冒煙測試（MIL-91）。用真的 PostgreSQL 18 容器，走過 demo 部署會用到的路徑：
# migration（先用管理者建角色，再用 app_owner 重跑）→ 種子（連跑兩次）→ 啟動映像 →
# Basic Auth 與 webhook 驗簽（live 模式）→ 登入、建立物件、建立合約、mock 簽署、下載文件（mock 模式）→
# 重啟映像後資料仍在 PostgreSQL。
# 帶假的點點簽金鑰是為了走 live 模式：mock 模式的 webhook 不驗簽。這些請求都不會呼叫點點簽。
#
# 前提：宿主機有 Docker、Node.js 與 npm ci 過的 node_modules（migration 與種子在宿主機執行，與 deploy 工作相同）。
# 用法：deploy/smoke-test.sh <映像名稱>
# 環境變數：SMOKE_PORT 映像對外的 port，預設 18080。
set -euo pipefail

IMAGE="${1:?用法：deploy/smoke-test.sh <映像名稱>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-18080}"
BASE="http://127.0.0.1:${PORT}"
BASIC="demo:smoke-password"
SUFFIX="$$"
NETWORK="rent-poc-smoke-net-${SUFFIX}"
PG_CONTAINER="rent-poc-smoke-pg-${SUFFIX}"
APP_CONTAINER="rent-poc-smoke-app-${SUFFIX}"
ADMIN_PASSWORD="smoke-admin"
OWNER_PASSWORD="smoke-owner"
RW_PASSWORD="smoke-rw"
SEED_OWNER="smoke-owner@example.com"
COOKIE_FILE="$(mktemp)"

cleanup() {
  docker rm -f "$APP_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$COOKIE_FILE"
}
trap cleanup EXIT

fail() {
  echo "::error::$1"
  docker logs "$APP_CONTAINER" 2>&1 | tail -40 || true
  exit 1
}

# 容器逾時時用：印出容器狀態與 log 最後 30 行，再結束。
# PostgreSQL 與映像的啟動 log 不印出 POSTGRES_PASSWORD，這裡仍把管理者密碼遮掉
fail_container() {
  local container="$1" message="$2"
  echo "::error::${message}"
  echo "--- docker ps -a：${container}"
  docker ps -a --filter "name=^${container}\$" || true
  echo "--- ${container} 的 log 最後 30 行"
  docker logs "$container" 2>&1 | tail -30 | sed "s/${ADMIN_PASSWORD}/***/g" || true
  exit 1
}

expect_status() {
  local expected="$1" description="$2"
  shift 2
  local actual
  actual="$(curl -s -o /dev/null -w '%{http_code}' "$@" || true)"
  [ "$actual" = "$expected" ] || fail "${description}：預期 ${expected}，實際 ${actual}"
  echo "通過：${description}"
}

# --- PostgreSQL --------------------------------------------------------------

docker network create "$NETWORK" >/dev/null
# 先拉映像，下載時間不計入等待時間
for attempt in 1 2 3; do
  docker pull postgres:18 >/dev/null && break
  [ "$attempt" != 3 ] || fail "docker pull postgres:18 連續失敗 3 次"
  sleep 5
done
docker run -d --name "$PG_CONTAINER" --network "$NETWORK" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$ADMIN_PASSWORD" postgres:18 >/dev/null
# 官方映像先啟動只聽 unix socket 的暫時伺服器跑初始化，關閉後才啟動正式伺服器。
# 暫時伺服器也會讓不帶 -h 的 pg_isready 回報就緒，之後的檢查會撞上兩者之間的空檔。
# 所以這裡用 -h 127.0.0.1 檢查 TCP：只有正式伺服器聽 TCP
PG_READY=0
for _ in $(seq 1 120); do
  if docker exec "$PG_CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then PG_READY=1; break; fi
  sleep 1
done
[ "$PG_READY" = 1 ] || fail_container "$PG_CONTAINER" "PostgreSQL 在 120 秒內沒有就緒"
sleep 3
for _ in $(seq 1 30); do
  docker exec "$PG_CONTAINER" psql -U postgres -c 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
PG_PORT="$(docker port "$PG_CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "$PG_PORT" ] || fail "取不到 PostgreSQL 的對外 port"
HOST_URL() { echo "postgres://$1:$2@127.0.0.1:${PG_PORT}/postgres"; }

cd "$ROOT"

# 第一次 migration 必須用管理者連線：它建立 app_owner、app_rw 等角色
DATABASE_URL="$(HOST_URL postgres "$ADMIN_PASSWORD")" npm run --silent db:migrate >/dev/null || fail "管理者執行 migration 失敗"
echo "通過：管理者執行 migration"
docker exec "$PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE app_owner PASSWORD '${OWNER_PASSWORD}'" -c "ALTER ROLE app_rw PASSWORD '${RW_PASSWORD}'" >/dev/null

# deploy 工作用 app_owner 重跑 migration。沒有新的 migration 時不做任何事
RERUN="$(DATABASE_URL="$(HOST_URL app_owner "$OWNER_PASSWORD")" npm run --silent db:migrate)" || fail "app_owner 重跑 migration 失敗"
echo "$RERUN" | grep -q '沒有待執行的 migration' || fail "app_owner 重跑 migration 時還有待執行的項目：${RERUN}"
echo "通過：app_owner 重跑 migration，沒有待執行的項目"

# 種子用 app_rw（與應用程式相同）。連跑兩次，第二次不得建立任何東西
export DEMO_SEED_OWNER_EMAIL="$SEED_OWNER"
SEED_URL="$(HOST_URL app_rw "$RW_PASSWORD")"
DATABASE_URL="$SEED_URL" npm run --silent db:seed >/dev/null || fail "第一次執行種子失敗"
SECOND="$(DATABASE_URL="$SEED_URL" npm run --silent db:seed)" || fail "第二次執行種子失敗"
if echo "$SECOND" | grep -q '已建立'; then fail "第二次執行種子又建立了資料：${SECOND}"; fi
echo "通過：種子連跑兩次，第二次沒有建立資料"

# --- 映像 ---------------------------------------------------------------------

APP_DATABASE_URL="postgres://app_rw:${RW_PASSWORD}@${PG_CONTAINER}:5432/postgres"

# 用法：start_app [額外的 docker 參數...]
start_app() {
  docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$APP_CONTAINER" --network "$NETWORK" --memory=1g --cpus=1 -p "127.0.0.1:${PORT}:8080" \
    -e DATABASE_URL="$APP_DATABASE_URL" \
    -e MAILER_ADAPTER=log \
    -e AUTH_SECRET=smoke-auth-secret \
    -e DEMO_BASIC_AUTH_USER=demo \
    -e DEMO_BASIC_AUTH_PASSWORD=smoke-password \
    "$@" \
    "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/health")" = "200" ]; then return 0; fi
    sleep 1
  done
  fail_container "$APP_CONTAINER" "/api/health 在 60 秒內沒有回 200"
}

run_flow() {
  SMOKE_BASE="$BASE" SMOKE_BASIC_AUTH="$BASIC" SMOKE_EMAIL="$SEED_OWNER" SMOKE_COOKIE_FILE="$COOKIE_FILE" "$@" node "$ROOT/deploy/smoke-flow.mjs" \
    || fail "主流程冒煙失敗"
}

# 階段一：live 模式（假金鑰）。檢查存取控制與 webhook 驗簽
start_app -e DOTTEDSIGN_CLIENT_ID=smoke-client-id -e DOTTEDSIGN_CLIENT_SECRET=smoke-client-secret
echo "通過：映像啟動，/api/health 回 200（連得上 PostgreSQL）"
expect_status 401 "沒有帳號密碼時擋下頁面" "${BASE}/properties"
expect_status 401 "沒有帳號密碼時擋下 API" "${BASE}/api/contracts"
expect_status 401 "密碼錯誤時擋下" -u demo:wrong "${BASE}/properties"
expect_status 307 "帳號密碼正確但沒有登入時，頁面導向登入頁" -u "$BASIC" "${BASE}/properties"
expect_status 401 "帳號密碼正確但沒有登入時，API 回 401" -u "$BASIC" "${BASE}/api/contracts"
expect_status 200 "webhook 驗證 ping 不需要帳號密碼" -X POST "${BASE}/api/webhooks/dottedsign"
expect_status 401 "webhook 帶錯誤簽章時擋下" -X POST -H 'signature: bad' -d '{"resource_id":1}' "${BASE}/api/webhooks/dottedsign"

# 階段二：mock 模式（不帶金鑰）。走完整的主流程
start_app
run_flow

# 階段三：重啟映像，資料仍在 PostgreSQL。換新的容器就是換新的實例
start_app
run_flow env SMOKE_EXPECT_EXISTING=1
echo "通過：重啟映像後，先前建立的資料仍在 PostgreSQL"

echo "冒煙測試全部通過"
