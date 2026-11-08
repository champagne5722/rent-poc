import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createMockProvider } from './mock-adapter';
import { ulidOf } from '../test-ids';

const headers = new Headers();
const event = JSON.stringify({ resource_id: 'mock-1-abc', resource_type: 'task', action_name: 'completed' });

describe('mock adapter 的 webhook', () => {
  it('本機預設接受沒有簽章的事件，方便手動模擬', () => {
    const parsed = createMockProvider().parseWebhook(event, headers);
    expect(parsed.kind).not.toBe('invalid');
  });

  it('部署環境沒有 client secret 能驗簽，非空 webhook 一律拒收', () => {
    const provider = createMockProvider({ rejectWebhookEvents: true });
    expect(provider.parseWebhook(event, headers)).toMatchObject({ kind: 'invalid', status: 401 });
  });

  it('部署環境仍回應空 body 的驗證 ping，點點簽後台才能儲存 webhook URL', () => {
    const provider = createMockProvider({ rejectWebhookEvents: true });
    expect(provider.parseWebhook('', headers)).toEqual({ kind: 'ping' });
  });
});

describe('mock adapter 的文件下載', () => {
  const subject = { type: 'contract', id: ulidOf(7) } as const;
  const document = { fileName: '租賃合約', pdf: new Uint8Array([37, 80, 68, 70, 1]), pageSize: { width: 1, height: 1 } };

  it('已簽 PDF 回傳建立任務時收到的 PDF', async () => {
    const provider = createMockProvider();
    const { taskRef } = await provider.createTask({ subject, document, signers: [] });
    expect(await provider.downloadFile(taskRef, 'signed_pdf')).toEqual(document.pdf);
  });

  it('有保存目錄時，換一個 adapter 實例仍能取回 PDF，等同重新啟動', async () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-signing-'));
    try {
      const { taskRef } = await createMockProvider({ storeDir }).createTask({ subject, document, signers: [] });
      expect(await createMockProvider({ storeDir }).downloadFile(taskRef, 'signed_pdf')).toEqual(document.pdf);
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('沒有收到過 PDF 的任務回明確訊息', async () => {
    await expect(createMockProvider().downloadFile('mock-1-legacy', 'signed_pdf')).rejects.toThrow(
      'mock 模式找不到送簽時的 PDF'
    );
  });

  it('沒有 Audit Trail File，訊息與宣告的不支援訊息相同', async () => {
    const provider = createMockProvider();
    expect(provider.unsupported.files?.audit_trail).toBe('mock 模式沒有真實簽署任務，無法提供Audit Trail File');
    await expect(provider.downloadFile('mock-1-abc', 'audit_trail')).rejects.toThrow(
      'mock 模式沒有真實簽署任務，無法提供Audit Trail File'
    );
  });
});
