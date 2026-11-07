import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CONTRACT_FILE_LABELS } from '../types';
import { parseDottedSignPayload } from './dottedsign-adapter';
import type { SigningProvider } from './provider';

const UNSUPPORTED = {
  signLink: 'mock 模式無簽署連結',
  resend: 'mock 模式不寄信',
  files: { audit_trail: `mock 模式沒有真實簽署任務，無法提供${CONTRACT_FILE_LABELS.audit_trail}` },
};

const MISSING_PDF = 'mock 模式找不到送簽時的 PDF';

// 送簽時收到的 PDF。mock 沒有真的簽署，所以下載已簽 PDF 時回傳這份。
interface DocumentStore {
  put(taskRef: string, pdf: Uint8Array): void;
  get(taskRef: string): Uint8Array | null;
}

// 沒給目錄時只存在記憶體，測試用。開發伺服器要給目錄，重新啟動後才取得回來。
function documentStore(storeDir?: string): DocumentStore {
  if (!storeDir) {
    const memory = new Map<string, Uint8Array>();
    return { put: (ref, pdf) => memory.set(ref, pdf), get: (ref) => memory.get(ref) ?? null };
  }
  // 任務編號由 createTask 產生，只含英數與連字號。其他字元一律視為不存在，避免組出目錄外的路徑。
  const fileOf = (ref: string) => (/^[\w-]+$/.test(ref) ? path.join(storeDir, `${ref}.pdf`) : null);
  return {
    put(ref, pdf) {
      const file = fileOf(ref);
      if (!file) throw new Error(`mock 任務編號格式不符：${ref}`);
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(file, pdf);
    },
    get(ref) {
      const file = fileOf(ref);
      return file && fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null;
    },
  };
}

// Mock adapter：未設定點點簽金鑰時使用。不打外部 API。
// webhook 沿用點點簽的 payload 形狀，只是不驗證簽章。
// 部署環境的 webhook 路徑是公開的，mock 沒有 client secret 能驗簽，所以要拒收非空事件。
// 空 body 的 ping 仍回應，點點簽後台才能儲存 webhook URL。模擬簽署走 simulateEvent，不受影響。
export function createMockProvider(options: { rejectWebhookEvents?: boolean; storeDir?: string } = {}): SigningProvider {
  const documents = documentStore(options.storeDir);
  return {
    id: 'mock',
    mode: 'mock',
    unsupported: UNSUPPORTED,
    createTask: async ({ subject, document }) => {
      const taskRef = `mock-${subject.id}-${crypto.randomUUID().slice(0, 8)}`;
      documents.put(taskRef, document.pdf);
      return { taskRef };
    },
    getSignLink: async () => {
      throw new Error(UNSUPPORTED.signLink);
    },
    resend: async () => {
      throw new Error(UNSUPPORTED.resend);
    },
    voidTask: async () => {},
    downloadFile: async (taskRef, kind) => {
      if (kind === 'audit_trail') throw new Error(UNSUPPORTED.files.audit_trail);
      const pdf = documents.get(taskRef);
      if (!pdf) throw new Error(MISSING_PDF);
      return pdf;
    },
    parseWebhook: (rawBody) => {
      if (!rawBody) return { kind: 'ping' };
      if (options.rejectWebhookEvents) return { kind: 'invalid', status: 401, reason: 'mock 模式不接受 webhook 事件' };
      return parseDottedSignPayload(rawBody);
    },
  };
}
