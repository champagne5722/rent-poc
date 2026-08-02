import { describe, expect, it } from 'vitest';
import type { Contract, ContractStatus } from './types';
import {
  buildDownloadLinkPath,
  checkContractFileDownloadable,
  contractFileName,
  contractFileRelPath,
  dsFileType,
  pickDownloadLinks,
} from './contract-files';

const contract = (status: ContractStatus, taskId: string | null = '470'): Contract =>
  ({
    id: 12,
    property_id: null,
    status,
    fields: {},
    signature_fields: [],
    dottedsign_task_id: taskId,
    declined_reason: null,
    created_at: '2026-08-02 10:00:00',
    updated_at: null,
  }) as unknown as Contract;

describe('點點簽下載連結組裝', () => {
  it('kind 對應官方 file_types 值', () => {
    expect(dsFileType('signed_pdf')).toBe('task');
    expect(dsFileType('audit_trail')).toBe('audit_trail');
  });

  it('一次要兩種檔案時帶兩個 file_types[]', () => {
    expect(buildDownloadLinkPath('470', ['signed_pdf', 'audit_trail'])).toBe(
      '/v1/sign_tasks/download_link?task_id=470&file_types[]=task&file_types[]=audit_trail'
    );
  });

  it('task_id 會做 URL 編碼', () => {
    expect(buildDownloadLinkPath('4 7/0', ['signed_pdf'])).toBe(
      '/v1/sign_tasks/download_link?task_id=4%207%2F0&file_types[]=task'
    );
  });

  it('回應以 file_types 值為 key，挑回內部 kind', () => {
    const json = { data: { task: 'https://s3/task.pdf', audit_trail: 'https://s3/audit.pdf' } };
    expect(pickDownloadLinks(json, ['signed_pdf', 'audit_trail'])).toEqual({
      signed_pdf: 'https://s3/task.pdf',
      audit_trail: 'https://s3/audit.pdf',
    });
  });

  it('缺少的 key 不出現在結果中，形狀不對回空物件', () => {
    expect(pickDownloadLinks({ data: { task: 'https://s3/task.pdf' } }, ['signed_pdf', 'audit_trail'])).toEqual({
      signed_pdf: 'https://s3/task.pdf',
    });
    expect(pickDownloadLinks({}, ['signed_pdf'])).toEqual({});
    expect(pickDownloadLinks(null, ['signed_pdf'])).toEqual({});
  });
});

describe('檔名與存檔路徑', () => {
  it('檔名帶合約編號與檔案種類', () => {
    expect(contractFileName(12, 'signed_pdf')).toBe('contract-12-signed.pdf');
    expect(contractFileName(12, 'audit_trail')).toBe('contract-12-audit-trail.pdf');
  });

  it('存檔路徑依合約分子目錄', () => {
    expect(contractFileRelPath(12, 'audit_trail')).toBe('contract-files/12/contract-12-audit-trail.pdf');
  });
});

describe('下載狀態判斷', () => {
  it('已完成且有簽署任務可下載', () => {
    expect(checkContractFileDownloadable(contract('completed'), 'signed_pdf', { mock: false })).toEqual({ ok: true });
    expect(checkContractFileDownloadable(contract('completed'), 'audit_trail', { mock: false })).toEqual({ ok: true });
  });

  it('未完成狀態回 409 與明確訊息', () => {
    for (const status of ['draft', 'awaiting_tenant', 'awaiting_landlord', 'declined', 'voided'] as const) {
      const result = checkContractFileDownloadable(contract(status), 'signed_pdf', { mock: false });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.status).toBe(409);
      expect(result.error).toContain('尚未完成簽署');
    }
  });

  it('mock 模式沒有 Audit Trail File，回 409', () => {
    const result = checkContractFileDownloadable(contract('completed', 'mock-12-abc'), 'audit_trail', { mock: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(409);
    expect(result.error).toContain('mock');
  });

  it('mock 模式的已簽 PDF 仍可下載（回未簽版示意）', () => {
    expect(checkContractFileDownloadable(contract('completed', 'mock-12-abc'), 'signed_pdf', { mock: true })).toEqual({
      ok: true,
    });
  });

  it('live 模式缺 task id 回 409', () => {
    const result = checkContractFileDownloadable(contract('completed', null), 'signed_pdf', { mock: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(409);
    expect(result.error).toContain('簽署任務');
  });
});
