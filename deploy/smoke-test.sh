#!/usr/bin/env bash
# 映像冒煙測試。用真的 Litestream 複寫到本機資料夾，驗證 Cloud Run 上會用到的行為：
# 原生模組與字型有進映像、Basic Auth、webhook 放行與驗簽、SIGTERM 時不遺失資料、重啟後還原。
# 帶假的點點簽金鑰是為了走 live 模式：mock 模式的 webhook 不驗簽。這些請求都不會呼叫點點簽。
# 用法：deploy/smoke-test.sh <映像名稱>
set -euo pipefail

IMAGE="${1:?用法：deploy/smoke-test.sh <映像名稱>}"
PORT=18080
BASE="http://127.0.0.1:${PORT}"
AUTH="demo:smoke-password"
CONTAINER="rent-poc-smoke-$$"
REPLICA_DIR="$(mktemp -d)"
# 容器內是 node 使用者，資料夾擁有者是 runner，所以開放寫入
chmod 777 "$REPLICA_DIR"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # 複寫檔案的擁有者是容器內的 node 使用者，runner 不一定能刪，失敗不影響結果
  rm -rf "$REPLICA_DIR" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "::error::$1"
  docker logs "$CONTAINER" 2>&1 | tail -40 || true
  exit 1
}

start_container() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --memory=1g --cpus=1 -p "${PORT}:8080" \
    -v "${REPLICA_DIR}:/replica" \
    -e LITESTREAM_FILE_ROOT=/replica \
    -e DEMO_BASIC_AUTH_USER=demo \
    -e DEMO_BASIC_AUTH_PASSWORD=smoke-password \
    -e DOTTEDSIGN_CLIENT_ID=smoke-client-id \
    -e DOTTEDSIGN_CLIENT_SECRET=smoke-client-secret \
    "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/health")" = "200" ]; then return 0; fi
    sleep 1
  done
  fail "/api/health 在 60 秒內沒有回 200"
}

expect_status() {
  local expected="$1" description="$2"
  shift 2
  local actual
  actual="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  [ "$actual" = "$expected" ] || fail "${description}：預期 ${expected}，實際 ${actual}"
  echo "通過：${description}"
}

create_property() {
  curl -s -u "$AUTH" -X POST "${BASE}/api/properties" -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"address\":\"冒煙測試路 1 號\",\"type\":\"整層住家\",\"size\":20,\"default_rent\":20000,\"note\":\"\",\"equipment\":[]}"
}

start_container

expect_status 401 "沒有帳號密碼時擋下頁面" "${BASE}/properties"
expect_status 401 "沒有帳號密碼時擋下 API" "${BASE}/api/contracts"
expect_status 401 "密碼錯誤時擋下" -u demo:wrong "${BASE}/properties"
expect_status 200 "帳號密碼正確時放行" -u "$AUTH" "${BASE}/properties"
expect_status 200 "webhook 驗證 ping 不需要帳號密碼" -X POST "${BASE}/api/webhooks/dottedsign"
expect_status 401 "webhook 帶錯誤簽章時擋下" -X POST -H 'signature: bad' -d '{"resource_id":1}' "${BASE}/api/webhooks/dottedsign"

PROPERTY_ID="$(create_property 'CURRENT 移動前' | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
[ -n "$PROPERTY_ID" ] || fail "建立物件失敗"
CONTRACT_ID="$(curl -s -u "$AUTH" -X POST "${BASE}/api/contracts" -H 'content-type: application/json' \
  -d "{\"property_id\":${PROPERTY_ID}}" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
[ -n "$CONTRACT_ID" ] || fail "建立合約失敗"
PDF_SIZE="$(curl -sL -u "$AUTH" -o /dev/null -w '%{size_download}' "${BASE}/api/contracts/${CONTRACT_ID}/pdf")"
[ "$PDF_SIZE" -gt 1000000 ] || fail "合約 PDF 只有 ${PDF_SIZE} bytes，字型可能沒有進映像"
echo "通過：合約 PDF ${PDF_SIZE} bytes"

for _ in $(seq 1 45); do
  [ -f "${REPLICA_DIR}/CURRENT" ] && break
  sleep 1
done
[ -f "${REPLICA_DIR}/CURRENT" ] || fail "45 秒內 CURRENT 沒有出現，Litestream 的複寫或還原有問題"
FIRST_CURRENT="$(cat "${REPLICA_DIR}/CURRENT")"
echo "通過：CURRENT 指向 ${FIRST_CURRENT}"

create_property 'SIGTERM 前最後寫入' >/dev/null
docker stop -t 10 "$CONTAINER" >/dev/null
start_container

LIST="$(curl -s -u "$AUTH" "${BASE}/api/properties")"
echo "$LIST" | grep -q 'CURRENT 移動前' || fail "重啟後遺失 CURRENT 移動前寫入的物件"
echo "通過：重啟後還原 CURRENT 移動前的資料"
echo "$LIST" | grep -q 'SIGTERM 前最後寫入' || fail "SIGTERM 前的最後寫入沒有同步到複寫路徑"
echo "通過：SIGTERM 前的最後寫入沒有遺失"

for _ in $(seq 1 45); do
  [ "$(cat "${REPLICA_DIR}/CURRENT")" != "$FIRST_CURRENT" ] && break
  sleep 1
done
[ "$(cat "${REPLICA_DIR}/CURRENT")" != "$FIRST_CURRENT" ] || fail "第二次啟動沒有換新的複寫路徑"
echo "通過：第二次啟動改寫到新路徑 $(cat "${REPLICA_DIR}/CURRENT")"

echo "冒煙測試全部通過"
