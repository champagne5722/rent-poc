import { createPrivateKey, sign, X509Certificate, createHash } from 'node:crypto';
import fs from 'node:fs';
import { derContext, derInteger, derNull, derOctetString, derOid, derSequence, derSet, parseDer } from './der';

// 離線的假 TSA，只給測試使用。用 fixtures/ 的測試根憑證簽出符合 RFC 3161 的回執，
// 讓 FreeTSA adapter 的契約測試不必連網。真實格式由 fixtures/freetsa-sample.tsr 對照（rfc3161.test.ts）。
// 測試根憑證與金鑰只用在這裡，沒有任何信任。

const FIXTURES = new URL('./fixtures/', import.meta.url);
const read = (name: string) => fs.readFileSync(new URL(name, FIXTURES), 'utf8');

export const TEST_ROOT_PEM = read('test-ca.pem');
const TSA_PEM = read('test-tsa.pem');
const TSA_KEY = createPrivateKey(read('test-tsa.key'));
const TSA_CERT = new X509Certificate(TSA_PEM);

export type FakeTsaMode = 'ok' | 'reject' | 'wrong-imprint' | 'wrong-nonce' | 'bad-signature';

export interface FakeTsaOptions {
  now: () => Date;
  mode?: FakeTsaMode;
}

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';

const generalizedTime = (d: Date) => {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const text = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return Buffer.concat([Buffer.from([0x18, text.length]), Buffer.from(text, 'ascii')]);
};

export class FakeTsa {
  /** 收到的請求次數。 */
  requests = 0;
  /** 最後一次請求裡的雜湊（十六進位）。 */
  lastImprintHex: string | null = null;
  mode: FakeTsaMode;
  private serial = 0;

  constructor(private readonly options: FakeTsaOptions) {
    this.mode = options.mode ?? 'ok';
  }

  /** 處理一個 TimeStampReq，回傳 TimeStampResp 的 DER。 */
  respond(requestBytes: Uint8Array): Buffer {
    this.requests++;
    const req = parseDer(requestBytes);
    const imprint = req.children[1];
    const nonceNode = req.children.find((c, i) => i >= 2 && c.tag === 0x02);
    this.lastImprintHex = imprint.children[1].value.toString('hex');

    if (this.mode === 'reject') return derSequence(derSequence(derInteger(2)));

    let imprintDer = imprint.raw;
    if (this.mode === 'wrong-imprint') {
      imprintDer = derSequence(derSequence(derOid(OID_SHA256), derNull()), derOctetString(Buffer.alloc(32, 9)));
    }
    const nonce = this.mode === 'wrong-nonce' && nonceNode ? derInteger(12345) : nonceNode ? derInteger(nonceNode.value) : null;
    const tst = derSequence(
      derInteger(1),
      derOid('1.2.3.4.1'),
      imprintDer,
      derInteger(++this.serial),
      generalizedTime(this.options.now()),
      ...(nonce ? [nonce] : []),
    );

    const attrs = [
      derSequence(derOid(OID_CONTENT_TYPE), derSet(derOid(OID_TST_INFO))),
      derSequence(derOid(OID_MESSAGE_DIGEST), derSet(derOctetString(createHash('sha256').update(tst).digest()))),
    ];
    const attrContent = Buffer.concat(attrs);
    const signedAttrs = derContext(0, attrContent);
    const toSign = Buffer.concat([Buffer.from([0x31]), signedAttrs.subarray(1)]);
    const signature = sign('sha256', toSign, TSA_KEY);
    if (this.mode === 'bad-signature') signature[10] ^= 0xff;

    const certNode = parseDer(TSA_CERT.raw);
    const tbs = certNode.children[0];
    const issuer = tbs.children[3];
    const serial = tbs.children[1];
    const signerInfo = derSequence(
      derInteger(1),
      derSequence(issuer.raw, serial.raw),
      derSequence(derOid(OID_SHA256), derNull()),
      signedAttrs,
      derSequence(derOid(OID_SHA256_RSA), derNull()),
      derOctetString(signature),
    );
    const signedData = derSequence(
      derInteger(3),
      derSet(derSequence(derOid(OID_SHA256), derNull())),
      derSequence(derOid(OID_TST_INFO), derContext(0, derOctetString(tst))),
      derContext(0, TSA_CERT.raw),
      derSet(signerInfo),
    );
    const token = derSequence(derOid(OID_SIGNED_DATA), derContext(0, signedData));
    return derSequence(derSequence(derInteger(0)), token);
  }

  /** 取代全域 fetch 的函式。只接受 POST。 */
  fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body = init.body as Uint8Array;
    return new Response(new Uint8Array(this.respond(body)), { status: 200, headers: { 'content-type': 'application/timestamp-reply' } });
  };
}
