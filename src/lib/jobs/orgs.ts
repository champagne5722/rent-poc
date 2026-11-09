import type { ControlTx } from '../pg/with-tx';

/**
 * job 逐組織執行時的組織清單（ADR-0020 決議 7）。平台組織只持有稽核鏈，沒有組織內的資料，所以略過。
 * 組織目錄在 control，不需要組織脈絡就能讀。
 */
export async function listWorkOrgIds(tx: ControlTx): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(`SELECT id FROM control.orgs WHERE kind <> 'platform' ORDER BY id`);
  return rows.map((r) => r.id);
}
