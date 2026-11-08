import path from 'path';
import { createContractSubscriber } from '../contract-signing';
import { DATA_DIR } from '../db';
import { dsClientSecret, dsFetch, isMockMode, verifySignersEnabled } from '../dottedsign';
import type { ContractFileKind } from '../types';
import { createDottedSignProvider } from './dottedsign-adapter';
import { createMockProvider } from './mock-adapter';
import { createSigningModule, signingErrorResponse } from './module';
import type { SigningSubject } from './provider';

// route handler 的入口。依環境變數選 adapter。
export const signing = createSigningModule({
  provider: isMockMode()
    ? createMockProvider({
        // Cloud Run 一定會注入 K_SERVICE
        rejectWebhookEvents: Boolean(process.env.K_SERVICE),
        // 送簽時的 PDF 要撐過開發伺服器重新啟動，下載已簽 PDF 時才取得回來
        storeDir: path.join(DATA_DIR, 'mock-signing'),
      })
    : createDottedSignProvider({
        request: dsFetch,
        clientSecret: dsClientSecret(),
        verifySigners: verifySignersEnabled(),
      }),
  subscribers: { contract: createContractSubscriber() },
  dataDir: DATA_DIR,
});

export function contractSubject(id: number): SigningSubject {
  return { type: 'contract', id };
}

// 下載端點共用：拒絕時回模組給的狀態碼與訊息，成功時回檔案本體與下載檔名
export async function signedFileResponse(subject: SigningSubject, kind: ContractFileKind): Promise<Response> {
  try {
    const file = await signing.downloadFile(subject, kind);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.fileName}"`,
      },
    });
  } catch (e) {
    return signingErrorResponse(e, '取得文件失敗');
  }
}

export { signingErrorResponse } from './module';
