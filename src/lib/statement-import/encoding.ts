// 編碼偵測與解碼。只接受 UTF-8 與 Big5（ADR-0050 決議 7），用 Node 內建的 TextDecoder，不加套件。

import type { StatementEncoding } from './types';

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** 能嚴格解成 UTF-8 就是 UTF-8，否則視為 Big5。純 ASCII 與空檔案是 UTF-8。 */
export function detectEncoding(bytes: Uint8Array): StatementEncoding {
  if (hasUtf8Bom(bytes)) return 'utf-8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'big5';
  }
}

/** 偵測編碼後解成文字，並去掉 UTF-8 BOM。 */
export function decodeStatement(bytes: Uint8Array): { encoding: StatementEncoding; text: string } {
  const encoding = detectEncoding(bytes);
  const body = encoding === 'utf-8' && hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
  return { encoding, text: new TextDecoder(encoding).decode(body) };
}
