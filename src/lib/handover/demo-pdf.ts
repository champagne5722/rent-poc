// 假資料用的已簽 PDF：一頁、只有一行 ASCII 文字的最小合法 PDF，幾百位元組。
// 同一個文件 ID 永遠產生同樣的位元組，假資料裡的 signedPdfSha256 由它算出。

export function demoSignedPdf(docId: string): Uint8Array {
  const text = `Demo signed PDF ${docId.replace(/[^A-Za-z0-9-]/g, '')}`;
  const stream = `BT /F1 18 Tf 72 760 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  // 全部是 ASCII，字元數等於位元組數，xref 的位移才正確
  return new TextEncoder().encode(body);
}
