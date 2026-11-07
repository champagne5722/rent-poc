import { NextRequest } from 'next/server';
import { contractSubject, signedFileResponse } from '@/lib/signing-module';

type Ctx = { params: Promise<{ id: string }> };

// 下載已簽 PDF：回合約完成時保存下來的檔案，沒保存到就當場向簽署服務商補抓一次。
// mock 模式回送簽時的 PDF 充當示意。
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return signedFileResponse(contractSubject(Number(id)), 'signed_pdf');
}
