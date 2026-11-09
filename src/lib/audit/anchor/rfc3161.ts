import { createHash, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { decodeOid, derBoolean, derInteger, derNull, derOctetString, derOid, derSequence, parseDer, readDerInteger, type DerNode } from './der';

// RFC 3161 時戳：請求編碼、回執解析、簽章與信任鏈驗證（ADR-0019 決議 9，MIL-88）。
// 只用 node:crypto 與 der.ts，不引入相依。送出的只有 32 位元組的雜湊，不含任何業務資料。
//
// 介面的規則：
// - 驗證不連網。信任根由呼叫端傳入，沒有信任根就拒絕，不退回「只驗內嵌憑證」：
//   內嵌憑證是回執自己帶的，不能證明簽發者是誰。
// - 保存的回執是 TimeStampToken（CMS ContentInfo 的 DER），不是整個 TimeStampResp。
// - 驗證項目：messageImprint 等於樹根、signedAttrs 的 messageDigest 等於 TSTInfo 的雜湊、
//   簽章、簽署憑證的信任鏈、憑證在 genTime 有效、憑證用途含 timeStamping。
// - 不支援：RSASSA-PSS、SHA-1。遇到時回報「不支援」，不假裝通過。

const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  sha384WithRsa: '1.2.840.113549.1.1.12',
  sha512WithRsa: '1.2.840.113549.1.1.13',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  ecdsaSha512: '1.2.840.10045.4.3.4',
  timeStamping: '1.3.6.1.5.5.7.3.8',
} as const;

const DIGEST_BY_OID: Record<string, string> = { [OID.sha256]: 'sha256', [OID.sha384]: 'sha384', [OID.sha512]: 'sha512' };
/** 簽章演算法 OID 對應的雜湊。rsaEncryption 沒有指定雜湊，改用 SignerInfo 的 digestAlgorithm。 */
const SIGNATURE_DIGEST: Record<string, string | null> = {
  [OID.rsaEncryption]: null,
  [OID.sha256WithRsa]: 'sha256',
  [OID.sha384WithRsa]: 'sha384',
  [OID.sha512WithRsa]: 'sha512',
  [OID.ecdsaSha256]: 'sha256',
  [OID.ecdsaSha384]: 'sha384',
  [OID.ecdsaSha512]: 'sha512',
};

const HEX64 = /^[0-9a-f]{64}$/;

/** TimeStampReq。雜湊固定 SHA-256，要求回執內嵌憑證（certReq）。 */
export function buildTimestampRequest(rootHex: string, nonce?: Uint8Array): Buffer {
  if (!HEX64.test(rootHex)) throw new Error('時戳請求的雜湊必須是 64 位小寫十六進位');
  const imprint = derSequence(derSequence(derOid(OID.sha256), derNull()), derOctetString(Buffer.from(rootHex, 'hex')));
  return derSequence(derInteger(1), imprint, ...(nonce ? [derInteger(nonce)] : []), derBoolean(true));
}

export interface TimestampResponse {
  /** PKIStatus：0 granted，1 grantedWithMods，其餘是拒絕。 */
  status: number;
  /** 被拒絕時的 failInfo（位元字串的十六進位），沒有則為 null。 */
  failInfo: string | null;
  /** TimeStampToken 的 DER。被拒絕時是 null。 */
  token: Buffer | null;
}

export function parseTimestampResponse(bytes: Uint8Array): TimestampResponse {
  const resp = parseDer(bytes);
  if (resp.tag !== 0x30 || resp.children.length < 1) throw new Error('時戳回應格式不合');
  const info = resp.children[0];
  if (info.tag !== 0x30 || info.children[0]?.tag !== 0x02) throw new Error('時戳回應的 PKIStatusInfo 格式不合');
  const status = Number(readDerInteger(info.children[0]));
  const failNode = info.children.find((c) => c.tag === 0x03);
  const granted = status === 0 || status === 1;
  const tokenNode = resp.children[1];
  if (granted && !tokenNode) throw new Error('時戳回應顯示已核發，但沒有 TimeStampToken');
  return { status, failInfo: failNode ? failNode.value.toString('hex') : null, token: granted ? Buffer.from(tokenNode.raw) : null };
}

export type TokenVerdict =
  | { ok: true; issuedAt: Date; nonce: bigint | null; serial: bigint }
  | { ok: false; reason: string };

export interface VerifyTokenOptions {
  rootHex: string;
  /** 信任根憑證（PEM）。至少一張。 */
  trustedRootsPem: readonly string[];
  /** 請求時用的 nonce（大端位元組）。驗證已保存的回執時不傳。 */
  expectedNonce?: Uint8Array;
}

class Reject extends Error {}
const fail = (reason: string): never => {
  throw new Reject(reason);
};

function parseGeneralizedTime(text: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(text);
  if (!m) return fail(`genTime 格式不合：${text}`);
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms));
}

const hexOfInteger = (node: DerNode) => readDerInteger(node).toString(16).toUpperCase();

function loadCertificates(nodes: DerNode[]): X509Certificate[] {
  return nodes.map((n) => {
    try {
      return new X509Certificate(n.raw);
    } catch {
      return fail('回執內嵌的憑證無法解析');
    }
  });
}

/** 從簽署憑證往上走到信任根。每一步都驗簽章，最多 5 層。 */
function chainsToTrustedRoot(signer: X509Certificate, embedded: X509Certificate[], roots: X509Certificate[]): boolean {
  let current = signer;
  for (let depth = 0; depth < 5; depth++) {
    if (roots.some((r) => current.checkIssued(r) && current.verify(r.publicKey))) return true;
    const parent = embedded.find((c) => c !== current && current.checkIssued(c) && current.verify(c.publicKey));
    if (!parent) return false;
    current = parent;
  }
  return false;
}

export function verifyTimestampToken(token: Uint8Array, options: VerifyTokenOptions): TokenVerdict {
  try {
    if (options.trustedRootsPem.length === 0) return fail('沒有設定信任根，無法驗證回執');
    const roots = options.trustedRootsPem.map((pem) => {
      try {
        return new X509Certificate(pem);
      } catch {
        return fail('信任根憑證無法解析');
      }
    });

    // ContentInfo { signedData, [0] SignedData }
    const content = parseDer(token);
    if (content.tag !== 0x30 || decodeOid(content.children[0]) !== OID.signedData) return fail('回執不是 CMS SignedData');
    const signedData = content.children[1]?.children[0];
    if (!signedData || signedData.tag !== 0x30) return fail('回執的 SignedData 格式不合');

    const encap = signedData.children[2];
    if (!encap || decodeOid(encap.children[0]) !== OID.tstInfo) return fail('回執的內容不是 TSTInfo');
    const tstBytes = encap.children[1]?.children[0]?.value;
    if (!tstBytes) return fail('回執沒有 TSTInfo');

    const certNodes = signedData.children.find((c) => c.tag === 0xa0)?.children ?? [];
    const signerInfos = signedData.children.length > 3 ? signedData.children.at(-1) : undefined;
    if (!signerInfos || signerInfos.tag !== 0x31 || signerInfos.children.length !== 1) return fail('回執必須剛好一位簽署者');
    const signerInfo = signerInfos.children[0];

    // --- TSTInfo：雜湊、時間、nonce ---
    const tst = parseDer(tstBytes);
    const [, , imprint, serialNode, genTimeNode, ...rest] = tst.children;
    if (!imprint || !serialNode || genTimeNode?.tag !== 0x18) return fail('TSTInfo 格式不合');
    if (decodeOid(imprint.children[0].children[0]) !== OID.sha256) return fail('TSTInfo 的雜湊演算法不是 SHA-256');
    if (imprint.children[1].value.toString('hex') !== options.rootHex) return fail('回執的雜湊與樹根不符');
    const issuedAt = parseGeneralizedTime(genTimeNode.value.toString('ascii'));
    const nonceNode = rest.find((c) => c.tag === 0x02);
    const nonce = nonceNode ? readDerInteger(nonceNode) : null;
    if (options.expectedNonce) {
      const expected = BigInt(`0x${Buffer.from(options.expectedNonce).toString('hex') || '0'}`);
      if (nonce !== expected) return fail('回執的 nonce 與請求不符');
    }

    // --- SignerInfo ---
    const [, sid, digestAlg, ...afterDigest] = signerInfo.children;
    const signedAttrs = afterDigest.find((c) => c.tag === 0xa0);
    const sigAlg = afterDigest.find((c) => c.tag === 0x30);
    const signature = afterDigest.find((c) => c.tag === 0x04);
    if (!sid || !digestAlg || !signedAttrs || !sigAlg || !signature) return fail('SignerInfo 格式不合');
    const digestName = DIGEST_BY_OID[decodeOid(digestAlg.children[0])];
    if (!digestName) return fail(`不支援的摘要演算法：${decodeOid(digestAlg.children[0])}`);

    // signedAttrs：contentType 與 messageDigest
    const attrs = new Map(signedAttrs.children.map((a) => [decodeOid(a.children[0]), a.children[1]?.children[0]]));
    const attrType = attrs.get(OID.contentType);
    if (!attrType || decodeOid(attrType) !== OID.tstInfo) return fail('signedAttrs 缺少 contentType 或不是 TSTInfo');
    const digestAttr = attrs.get(OID.messageDigest);
    if (!digestAttr) return fail('signedAttrs 缺少 messageDigest');
    const tstDigest = createHash(digestName).update(tstBytes).digest();
    if (!tstDigest.equals(digestAttr.value)) return fail('messageDigest 與 TSTInfo 不符');

    // 簽署憑證：依 issuerAndSerialNumber 的序號，或唯一的內嵌憑證
    const embedded = loadCertificates(certNodes);
    if (embedded.length === 0) return fail('回執沒有內嵌簽署憑證');
    const wantedSerial = sid.tag === 0x30 ? hexOfInteger(sid.children[1]) : null;
    const norm = (s: string) => s.replace(/^0+/, '').toUpperCase();
    const candidates = wantedSerial ? embedded.filter((c) => norm(c.serialNumber) === norm(wantedSerial)) : embedded;
    if (candidates.length === 0) return fail('找不到簽署者序號對應的憑證');

    const sigOid = decodeOid(sigAlg.children[0]);
    if (!(sigOid in SIGNATURE_DIGEST)) return fail(`不支援的簽章演算法：${sigOid}`);
    const sigDigest = SIGNATURE_DIGEST[sigOid] ?? digestName;
    // 簽章對的是 signedAttrs 以 SET OF（0x31）重新編碼的位元組
    const signedBytes = Buffer.concat([Buffer.from([0x31]), signedAttrs.raw.subarray(1)]);
    const signer = candidates.find((c) => cryptoVerify(sigDigest, signedBytes, c.publicKey, signature.value));
    if (!signer) return fail('簽章不符');

    // 憑證：信任鏈、有效期、用途
    if (!chainsToTrustedRoot(signer, embedded, roots)) return fail('簽署憑證不在信任根之下');
    if (issuedAt < new Date(signer.validFrom) || issuedAt > new Date(signer.validTo)) return fail('簽署憑證在回執時間已過期或尚未生效');
    if (!(signer.keyUsage ?? []).includes(OID.timeStamping)) return fail('簽署憑證沒有 timeStamping 用途');

    return { ok: true, issuedAt, nonce, serial: readDerInteger(serialNode) };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.message };
    // 其餘多半是格式損毀（DER 解析失敗）。一律回報成驗證失敗，不讓呼叫端遇到例外
    return { ok: false, reason: `回執格式損毀：${e instanceof Error ? e.message : String(e)}` };
  }
}
