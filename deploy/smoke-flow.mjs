// 映像冒煙測試的主流程（MIL-91）。由 deploy/smoke-test.sh 呼叫，對跑著的映像發 HTTP 請求。
// 流程：用種子屋主登入 → 建立物件 → 建立合約 → 補欄位與簽署區 → 送簽 → mock 簽署到完成 → 下載文件。
// 每一步都檢查回應本文，不只看狀態碼。任何一步不符就以 1 結束。
//
// 環境變數：SMOKE_COOKIE_FILE 指定時，登入後把 session cookie 存進去。
//   SMOKE_EXPECT_EXISTING=1 時，改讀 SMOKE_COOKIE_FILE 的 cookie，不重新登入，只檢查 session 與上一輪建立的物件仍在
//   （換了新的映像實例，資料與 session 都在 PostgreSQL）。
//   SMOKE_BASE（例 http://127.0.0.1:18080）、SMOKE_BASIC_AUTH（user:password）、SMOKE_EMAIL（種子屋主的 email）。
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE;
const BASIC = process.env.SMOKE_BASIC_AUTH;
const EMAIL = process.env.SMOKE_EMAIL;
if (!BASE || !BASIC || !EMAIL) {
  console.error('缺少 SMOKE_BASE、SMOKE_BASIC_AUTH 或 SMOKE_EMAIL');
  process.exit(2);
}

const basicHeader = `Basic ${Buffer.from(BASIC).toString('base64')}`;
let cookie = '';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function call(method, path, body) {
  const headers = { Authorization: basicHeader };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  return response;
}

async function json(method, path, body, expectedStatus = 200) {
  const response = await call(method, path, body);
  const text = await response.text();
  if (response.status !== expectedStatus) fail(`${method} ${path}：預期 ${expectedStatus}，實際 ${response.status}：${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${method} ${path}：回應不是 JSON：${text.slice(0, 300)}`);
  }
}

function check(condition, description) {
  if (!condition) fail(`不符：${description}`);
  console.log(`通過：${description}`);
}

if (process.env.SMOKE_EXPECT_EXISTING === '1') {
  cookie = readFileSync(process.env.SMOKE_COOKIE_FILE, 'utf8').trim();
  const again = await json('GET', '/api/properties');
  check(again.data.some((p) => p.name.startsWith('冒煙物件')), '換了新的映像實例，上一輪的 session 與物件仍在');
  process.exit(0);
}

// 1. 登入：寄驗證碼，從 /demo/otp 取碼，驗證後拿 session cookie
const sent = await json('POST', '/api/auth/otp', { email: EMAIL });
check(sent.data?.sent === true, '寄出登入驗證碼');

let code;
for (let attempt = 0; attempt < 10 && !code; attempt += 1) {
  const html = await (await call('GET', '/demo/otp')).text();
  const row = (html.match(/<tr[\s\S]*?<\/tr>/g) ?? []).find((r) => r.includes(EMAIL));
  code = row?.match(/>(\d{6})</)?.[1];
  if (!code) await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!code) fail('/demo/otp 找不到驗證碼');

const verifyResponse = await call('POST', '/api/auth/verify', { email: EMAIL, code });
const verifyBody = await verifyResponse.json();
check(verifyResponse.status === 200 && typeof verifyBody.data?.redirectTo === 'string', '驗證碼通過');
check(verifyBody.data.redirectTo !== '/login?notice=no-identity', '種子屋主登入後有組織身分');
const setCookie = verifyResponse.headers.getSetCookie().find((c) => c.startsWith('rp_session='));
if (!setCookie) fail('驗證後沒有收到 session cookie');
cookie = setCookie.split(';')[0];
if (process.env.SMOKE_COOKIE_FILE) writeFileSync(process.env.SMOKE_COOKIE_FILE, cookie);

// 2. 種子的示範物件在物件列表裡
const listed = await json('GET', '/api/properties');
check(
  Array.isArray(listed.data) && listed.data.some((p) => p.name.includes('示範物件')),
  '物件列表有種子建立的示範物件',
);

// 3. 建立物件。建號用每次不同的值，重跑冒煙不會撞到自己組織既有的那一筆
const buildingNo = String(20000 + Math.floor(Math.random() * 60000));
const created = await json(
  'POST',
  '/api/properties',
  {
    name: `冒煙物件 ${buildingNo}`,
    address: '臺北市大安區冒煙路 1 號',
    default_rent: 20000,
    equipment: [],
    anchor: { key: { city: 'A', town: '02', section: '0021', buildingNo, subNo: '' } },
  },
  201,
);
const createdId = created.data?.id;
check(typeof createdId === 'string' && createdId.length === 26, '建立物件，回傳物件 ID');

// 4. 建立合約草稿並補欄位與簽署區。物件通過平台的文件核對後才能建立合約（MIL-205，ADR-0028 決議 5）。
// 剛建立的物件還沒有核對，所以合約建在種子已核對的示範物件上。
const demo = listed.data.find((p) => p.name.includes('示範物件'));
check(demo?.verification_status === 'verified', '種子的示範物件已通過文件核對');
const propertyId = demo.id;
const blocked = await call('POST', '/api/contracts', { property_id: createdId });
check(blocked.status === 409, '剛建立、還沒核對的物件建立合約被拒（409）');
const draft = await json('POST', '/api/contracts', { property_id: propertyId }, 201);
const contractId = draft.data?.id;
check(typeof contractId === 'string' && contractId.length === 26, '建立合約，回傳合約 ID');
const read = await json('GET', `/api/contracts/${contractId}`);
check(read.data?.property_id === propertyId && read.data?.status === 'draft', '合約掛在已核對的示範物件，狀態是草稿');

const updated = await json('PUT', `/api/contracts/${contractId}`, {
  fields: {
    landlordName: '示範出租人',
    landlordEmail: 'smoke-landlord@example.com',
    tenantName: '示範承租人',
    tenantEmail: 'smoke-tenant@example.com',
    startDate: '2026-09-01',
    endDate: '2027-08-31',
  },
  signature_fields: [
    { id: 'f1', signer: 'party_a', page: 0, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
    { id: 'f2', signer: 'party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
  ],
});
check(updated.data?.id === contractId, '儲存草稿欄位與簽署區');
const reread = await json('GET', `/api/contracts/${contractId}`);
check(reread.data?.fields?.tenantName === '示範承租人', '重新讀取，草稿欄位已儲存');

// 5. 合約 PDF 帶字型，大小必須超過 1 MB
const pdf = await call('GET', `/api/contracts/${contractId}/pdf`);
const pdfBytes = Buffer.from(await pdf.arrayBuffer());
check(pdf.status === 200 && pdfBytes.subarray(0, 4).toString() === '%PDF', '合約 PDF 回 200 且檔頭是 %PDF');
check(pdfBytes.length > 1_000_000, `合約 PDF ${pdfBytes.length} bytes，字型有進映像`);

// 6. 送簽並用 mock 模式推進到完成
const sentContract = await json('POST', `/api/contracts/${contractId}/send`);
check(sentContract.data?.id === contractId && sentContract.data?.mock === true, '送簽成功，簽署走 mock 模式');
const afterSend = await json('GET', `/api/contracts/${contractId}`);
check(afterSend.data?.status !== 'draft', `送簽後合約狀態離開草稿（${afterSend.data?.status}）`);

const signed = await json('POST', '/api/mock/advance', { contract_id: contractId, event: 'signed' });
check(signed.data?.id === contractId, 'mock 乙方簽署');
const completed = await json('POST', '/api/mock/advance', { contract_id: contractId, event: 'completed' });
check(completed.data?.status === 'completed', 'mock 甲方簽署，合約完成');

const final = await json('GET', `/api/contracts/${contractId}`);
check(final.data?.status === 'completed', '重新讀取，合約狀態是 completed');

// 7. 下載已簽文件
const signedPdf = await call('GET', `/api/contracts/${contractId}/signed-pdf`);
const signedBytes = Buffer.from(await signedPdf.arrayBuffer());
check(signedPdf.status === 200 && signedBytes.subarray(0, 4).toString() === '%PDF', `下載已簽 PDF（${signedBytes.length} bytes）`);

console.log('主流程冒煙通過');
