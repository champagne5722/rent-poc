<!-- ste-lint: off -->
<!-- 給 agent 與開發者讀的重現步驟，內容是指令清單，句長規則不適用 -->
# anchor 測試固定資料

| 檔案 | 內容 |
|---|---|
| `test-tsa.key` | 假 TSA 的私鑰（RSA 2048，PKCS#8）。檔首有一行註解，`openssl` 讀檔時會略過 |
| `test-ca.crt` | 測試根憑證，自簽。`rfc3161.test.ts` 與 `providers.test.ts` 當信任根 |
| `test-tsa.crt` | 假 TSA 的憑證，由 `test-ca.crt` 簽發，公鑰對應 `test-tsa.key`。extendedKeyUsage 只有 timeStamping，且為 critical |
| `freetsa-sample.json` | FreeTSA 的真實回執樣本，對照格式用 |

這些憑證沒有任何信任，只給測試用。副檔名用 `.crt`，因為 `.gitignore` 的 `*.pem` 會擋掉 `.pem`（MIL-88 因此漏提交過一次）。

有效期 2026-01-01 到 2046-01-01，共 20 年。測試的回執時間固定在 2026-11-10，落在有效期內。

## 重新產生

根金鑰用完即丟，不提交。`test-tsa.key` 不變，所以 `test-tsa.crt` 的公鑰要與它相同。在這個目錄執行：

```bash
T=$(mktemp -d)
sed -n '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/p' test-tsa.key > $T/tsa.key
openssl genrsa -out $T/root.key 2048

cat > $T/root.cnf <<'CNF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = rent-poc Test TSA Root CA
O = rent-poc test fixtures
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
CNF

cat > $T/tsa.cnf <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = rent-poc Test TSA
O = rent-poc test fixtures
[v3_tsa]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF

openssl req -x509 -new -key $T/root.key -sha256 -config $T/root.cnf \
  -not_before 20260101000000Z -not_after 20460101000000Z -out test-ca.crt
openssl req -new -key $T/tsa.key -config $T/tsa.cnf -out $T/tsa.csr
openssl x509 -req -in $T/tsa.csr -CA test-ca.crt -CAkey $T/root.key -set_serial 0x1001 -sha256 \
  -extfile $T/tsa.cnf -extensions v3_tsa -not_before 20260101000000Z -not_after 20460101000000Z -out test-tsa.crt
rm -rf $T
```

`-not_before` 與 `-not_after` 需要 OpenSSL 3.4 以上。檢查：

```bash
openssl verify -CAfile test-ca.crt test-tsa.crt
diff <(openssl x509 -in test-tsa.crt -noout -pubkey) <(sed -n '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/p' test-tsa.key | openssl pkey -pubout)
```
