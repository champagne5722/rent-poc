import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyContractAsDraft, createContract, deleteDraftContract, getContract, saveDraft } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import { defaultStatusAnnex, statusAnnexOf, type StatusAnnex } from './index';

// 現況確認附件隨草稿保存（MIL-71）：內容收在合約欄位，所以複製為新草稿會跟著複製，刪除草稿時一起消失，
// 沒有附件的舊包租合約讀入不報錯。資料庫是 PGlite（MIL-85）。

let kit: RouteDb;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

beforeEach(() => kit.reset());

const MASTER = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };

function annexWithDefect(): StatusAnnex {
  const annex = defaultStatusAnnex();
  return {
    ...annex,
    rows: annex.rows.map((r, i) => ({ ...r, status: i === 1 ? ('defect' as const) : ('normal' as const), note: i === 1 ? '浴室天花板有水漬' : '' })),
  };
}

const insert = (fields: object): Promise<string> =>
  inA((tx) => createContract(tx, { property_id: null, fields: fields as unknown as ContractFields, signature_fields: [] }));

const load = (id: string) => inA((tx) => getContract(tx, id));

describe('現況確認附件的草稿生命週期', () => {
  it('存進草稿再讀回來，內容與版本、標籤都在', async () => {
    const annex = annexWithDefect();
    const id = await insert({ routing: MASTER, statusAnnex: annex });
    expect((await load(id))?.fields).toMatchObject({ statusAnnex: annex });
  });

  it('複製為新草稿時附件內容跟著複製，兩份互不影響', async () => {
    const annex = annexWithDefect();
    const id = await insert({ routing: MASTER, statusAnnex: annex });
    const copyId = (await inA((tx) => copyContractAsDraft(tx, id)))!;
    const copied = (await load(copyId))!;
    expect(copied.status).toBe('draft');
    expect('statusAnnex' in copied.fields && copied.fields.statusAnnex).toEqual(annex);
    expect(statusAnnexOf('draft', 'lease', copied.fields)).toEqual(annex);
    // 改新草稿不動來源
    await inA(async (tx) => {
      const current = (await getContract(tx, copyId, 'update'))!;
      await saveDraft(tx, copyId, {
        fields: { routing: MASTER, statusAnnex: defaultStatusAnnex() } as unknown as ContractFields,
        signature_fields: current.signature_fields,
      });
    });
    expect((await load(id))?.fields).toMatchObject({ statusAnnex: annex });
  });

  it('刪除草稿時附件一併消失（內容在合約欄位，沒有殘留的子表資料）', async () => {
    const id = await insert({ routing: MASTER, statusAnnex: annexWithDefect() });
    expect(await inA((tx) => deleteDraftContract(tx, id))).toBe('deleted');
    expect(await load(id)).toBeNull();
    const tables = await inA((tx) =>
      tx.query("SELECT tablename FROM pg_catalog.pg_tables WHERE tablename LIKE '%status_annex%'"),
    );
    expect(tables.rows).toEqual([]);
  });

  it('沒有附件內容的舊包租合約讀入不報錯：草稿印預設清單，送簽後的舊合約不印附件頁', async () => {
    const id = await insert({ routing: MASTER, landlordName: '王', tenantName: '李' });
    const fields = (await load(id))!.fields;
    expect(() => statusAnnexOf('draft', 'lease', fields)).not.toThrow();
    expect(statusAnnexOf('draft', 'lease', fields)?.rows.every((r) => r.status === null)).toBe(true);
    expect(statusAnnexOf('completed', 'lease', fields)).toBeNull();
  });
});
