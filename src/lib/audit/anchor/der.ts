// 最小的 ASN.1 DER 編碼與解析，只涵蓋 RFC 3161 時戳請求與回執用到的型別（MIL-88）。
// 不引入相依：編碼只有十來種型別，解析不需要 schema，由 rfc3161.ts 依位置取值。
//
// 限制：只支援單位元組 tag、定長度。回執是 DER，不會出現不定長度（BER）。遇到時丟錯，不嘗試猜測。

export interface DerNode {
  /** 第一個位元組：類別、是否建構、tag 號碼。 */
  tag: number;
  /** 內容（不含標頭）。 */
  value: Buffer;
  /** 含標頭的原始位元組。簽章要對原始位元組重算。 */
  raw: Buffer;
  /** 建構型別（tag 的 0x20 位元）的子節點，其餘是空陣列。 */
  children: DerNode[];
}

const TAG = { boolean: 0x01, integer: 0x02, octetString: 0x04, null: 0x05, oid: 0x06, sequence: 0x30, set: 0x31 } as const;

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

const toBuffer = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export function derSequence(...items: Uint8Array[]): Buffer {
  return tlv(TAG.sequence, Buffer.concat(items));
}

export function derSet(...items: Uint8Array[]): Buffer {
  return tlv(TAG.set, Buffer.concat(items));
}

/** [n] EXPLICIT 或 IMPLICIT 的建構型標籤，內容由呼叫端決定。 */
export function derContext(n: number, ...items: Uint8Array[]): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 30) throw new Error('DER：context tag 只支援 0 到 30');
  return tlv(0xa0 | n, Buffer.concat(items));
}

export function derNull(): Buffer {
  return tlv(TAG.null, Buffer.alloc(0));
}

export function derBoolean(value: boolean): Buffer {
  return tlv(TAG.boolean, Buffer.from([value ? 0xff : 0x00]));
}

export function derOctetString(bytes: Uint8Array): Buffer {
  return tlv(TAG.octetString, toBuffer(bytes));
}

/** 非負整數。傳數字或大端位元組。高位元為 1 時補 00，避免被讀成負數。 */
export function derInteger(value: number | Uint8Array): Buffer {
  let bytes: Buffer;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('DER：INTEGER 只支援非負安全整數');
    bytes = Buffer.from(value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, '0'), 'hex');
  } else {
    bytes = toBuffer(value);
  }
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && (bytes[start + 1] & 0x80) === 0) start++;
  bytes = bytes.subarray(start);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(TAG.integer, bytes);
}

export function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isSafeInteger(p) || p < 0)) throw new Error(`DER：OID 格式不合：${oid}`);
  const out: number[] = [];
  const base128 = (n: number) => {
    const chunk: number[] = [n & 0x7f];
    for (let rest = Math.floor(n / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80);
    out.push(...chunk);
  };
  base128(parts[0] * 40 + parts[1]);
  for (const p of parts.slice(2)) base128(p);
  return tlv(TAG.oid, Buffer.from(out));
}

function readHeader(buf: Buffer, offset: number): { tag: number; headerLength: number; length: number } {
  if (offset + 2 > buf.length) throw new Error('DER：資料不完整（標頭）');
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new Error('DER：不支援多位元組 tag');
  const first = buf[offset + 1];
  if (first === 0x80) throw new Error('DER：不支援不定長度');
  if (first < 0x80) return { tag, headerLength: 2, length: first };
  const count = first & 0x7f;
  if (count > 4 || offset + 2 + count > buf.length) throw new Error('DER：長度欄位不合');
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + buf[offset + 2 + i];
  return { tag, headerLength: 2 + count, length };
}

function parseAt(buf: Buffer, offset: number): { node: DerNode; end: number } {
  const { tag, headerLength, length } = readHeader(buf, offset);
  const start = offset + headerLength;
  const end = start + length;
  if (end > buf.length) throw new Error('DER：資料不完整（內容）');
  const value = buf.subarray(start, end);
  const children: DerNode[] = [];
  if (tag & 0x20) {
    let pos = 0;
    while (pos < value.length) {
      const child = parseAt(value, pos);
      children.push(child.node);
      pos = child.end;
    }
  }
  return { node: { tag, value, raw: buf.subarray(offset, end), children }, end };
}

/** 解析一個完整的 DER 值。多餘或不足的位元組都丟錯。 */
export function parseDer(input: Uint8Array): DerNode {
  const buf = toBuffer(input);
  if (buf.length === 0) throw new Error('DER：沒有資料');
  const { node, end } = parseAt(buf, 0);
  if (end !== buf.length) throw new Error('DER：值之後還有多餘的位元組');
  return node;
}

export function decodeOid(node: DerNode): string {
  if (node.tag !== TAG.oid || node.value.length === 0) throw new Error('DER：不是 OID');
  const parts: number[] = [];
  let acc = 0;
  for (const byte of node.value) {
    acc = acc * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(acc);
      acc = 0;
    }
  }
  const first = parts[0];
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...parts.slice(1)].join('.');
}

export function readDerInteger(node: DerNode): bigint {
  if (node.tag !== TAG.integer || node.value.length === 0) throw new Error('DER：不是 INTEGER');
  return BigInt(`0x${node.value.toString('hex')}`);
}
