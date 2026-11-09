import { describe, expect, it } from 'vitest';
import { derBoolean, derContext, derInteger, derNull, derOctetString, derOid, derSequence, derSet, decodeOid, parseDer, readDerInteger } from './der';

// 最小的 ASN.1 DER 編碼與解析（RFC 3161 用）。期望的位元組取自 X.690 的範例與 openssl asn1parse 的輸出。

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('DER 編碼', () => {
  it('OID：sha256 與 signedData', () => {
    expect(hex(derOid('2.16.840.1.101.3.4.2.1'))).toBe('0609608648016503040201');
    expect(hex(derOid('1.2.840.113549.1.7.2'))).toBe('06092a864886f70d010702');
  });

  it('INTEGER：最小長度，高位元為 1 時補 00', () => {
    expect(hex(derInteger(1))).toBe('020101');
    expect(hex(derInteger(127))).toBe('02017f');
    expect(hex(derInteger(128))).toBe('02020080');
    expect(hex(derInteger(256))).toBe('02020100');
    expect(hex(derInteger(Buffer.from('8000000000000000', 'hex')))).toBe('0209008000000000000000');
  });

  it('BOOLEAN、NULL、OCTET STRING', () => {
    expect(hex(derBoolean(true))).toBe('0101ff');
    expect(hex(derBoolean(false))).toBe('010100');
    expect(hex(derNull())).toBe('0500');
    expect(hex(derOctetString(Buffer.from('abc')))).toBe('0403616263');
  });

  it('SEQUENCE、SET、context tag', () => {
    expect(hex(derSequence(derInteger(1), derNull()))).toBe('30050201010500');
    expect(hex(derSet(derNull()))).toBe('31020500');
    expect(hex(derContext(0, derNull()))).toBe('a0020500');
  });

  it('長度 128 位元組以上用長格式', () => {
    const v = derOctetString(Buffer.alloc(200));
    expect(hex(v.subarray(0, 3))).toBe('0481c8');
    expect(v.length).toBe(203);
    const w = derOctetString(Buffer.alloc(300));
    expect(hex(w.subarray(0, 4))).toBe('0482012c');
  });
});

describe('DER 解析', () => {
  it('解出 tag、長度與子節點', () => {
    const node = parseDer(derSequence(derInteger(5), derOctetString(Buffer.from('hi')), derContext(0, derNull())));
    expect(node.tag).toBe(0x30);
    expect(node.children.map((c) => c.tag)).toEqual([0x02, 0x04, 0xa0]);
    expect(readDerInteger(node.children[0])).toBe(BigInt(5));
    expect(hex(node.children[1].value)).toBe('6869');
    expect(node.children[2].children[0].tag).toBe(0x05);
  });

  it('raw 保留含標頭的原始位元組，用來重新計算簽章', () => {
    const inner = derSequence(derInteger(300));
    const node = parseDer(derSequence(inner));
    expect(hex(node.children[0].raw)).toBe(hex(inner));
  });

  it('OID 往返', () => {
    expect(decodeOid(parseDer(derOid('1.2.840.113549.1.9.16.1.4')))).toBe('1.2.840.113549.1.9.16.1.4');
    expect(decodeOid(parseDer(derOid('2.16.840.1.101.3.4.2.1')))).toBe('2.16.840.1.101.3.4.2.1');
  });

  it('長格式長度往返', () => {
    const node = parseDer(derSequence(derOctetString(Buffer.alloc(300, 7))));
    expect(node.children[0].value.length).toBe(300);
  });

  it('不完整或多餘的位元組丟錯', () => {
    expect(() => parseDer(Buffer.from('3005020101', 'hex'))).toThrow(/DER/);
    expect(() => parseDer(Buffer.from('0500ff', 'hex'))).toThrow(/DER/);
    expect(() => parseDer(Buffer.alloc(0))).toThrow(/DER/);
  });

  it('不支援不定長度與多位元組 tag', () => {
    expect(() => parseDer(Buffer.from('3080050000', 'hex'))).toThrow(/DER/);
    expect(() => parseDer(Buffer.from('1f2002', 'hex'))).toThrow(/DER/);
  });
});
