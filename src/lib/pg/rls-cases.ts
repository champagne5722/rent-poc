import { newUlid } from './ulid';
import type { OrgTx } from './with-tx';

// 滲透測試的案例清單（ADR-0012 決議 6，MIL-81 建骨架，MIL-89 擴充）。
//
// 規則：org schema 的每張表必須在 ORG_TABLE_CASES 登記一個案例。
// rls-penetration.test.ts 從系統目錄列出 org 的所有表，缺案例就讓測試失敗，
// 所以新增 org 表的人不能略過隔離測試。
//
// 一個案例只需要說明「怎麼在某個組織寫入一列」。測試對每張表自動跑通用探測：
//   1. 自己看得到、改得到、刪得到
//   2. 別的組織看不到、改不到、刪不到（UPDATE 與 DELETE 影響 0 列）
//   3. 在 A 的脈絡寫入 B 的 org_id，被 RLS 擋下
//   4. 沒有組織脈絡時 0 筆
//   5. 兩個組織用同一組業務鍵各寫一列，都成功（陷阱 6：唯一鍵必須含 org_id）
// 表專屬的探測（複合外鍵穿透、view 的 security_invoker、併發）由 MIL-89 在 extra 欄位補。

export interface OrgTableCase {
  /**
   * 只增不改的表（同意紀錄、合約歷程）。app_rw 沒有 UPDATE 與 DELETE 權限，
   * 探測 2、3 改成預期「permission denied」，而不是 0 列。其餘探測不變。
   */
  appendOnly?: boolean;
  /**
   * 在 tx 的脈絡內寫入一列，org_id 欄位用傳入的 orgId，回傳主鍵（欄位名一律是 id）。
   * 業務鍵必須固定，不得每次隨機：探測 5 靠兩個組織寫入同一組業務鍵，驗證唯一鍵含 org_id。
   * 需要父列（例如 registry 的租賃單位）時，在這裡一併建立。
   */
  seed(tx: OrgTx, orgId: string): Promise<string>;
}

export const ORG_TABLE_CASES: Record<string, OrgTableCase> = {
  'org.properties': {
    async seed(tx, orgId) {
      const unitId = newUlid();
      await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), unitId, '滲透測試地址']);
      const id = newUlid();
      await tx.query(
        'INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)',
        [id, orgId, unitId, '滲透測試物件', '滲透測試地址'],
      );
      return id;
    },
  },
  'org.equipment_vocabulary': {
    async seed(tx, orgId) {
      const id = newUlid();
      await tx.query('INSERT INTO org.equipment_vocabulary (id, org_id, name, is_custom) VALUES ($1, $2, $3, true)', [
        id,
        orgId,
        '滲透測試設備',
      ]);
      return id;
    },
  },
  'org.contracts': {
    async seed(tx, orgId) {
      const id = newUlid();
      // legacy_id 固定：兩個組織寫同一組業務鍵 (org_id, legacy_id) 都要成功（陷阱 6）
      await tx.query('INSERT INTO org.contracts (id, org_id, legacy_id) VALUES ($1, $2, 1)', [id, orgId]);
      return id;
    },
  },
  'org.contract_events': {
    appendOnly: true,
    async seed(tx, orgId) {
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.contract_events (id, org_id, contract_id, type, actor, legacy_id) VALUES ($1, $2, $3, 'created', 'landlord', 1)`,
        [id, orgId, contractId],
      );
      return id;
    },
  },
  'org.consent_records': {
    appendOnly: true,
    // 直接 INSERT 而不用 recordConsent：探測 4 要在 A 的脈絡寫入 B 的 org_id，recordConsent 沒有這個參數。
    // 業務鍵（告知類型、對象 email）固定。稽核位置只是欄位值，探測不需要真的稽核事件。
    async seed(tx, orgId) {
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.consent_records
           (id, org_id, notice_type, notice_version, text_sha256, subject_email, decision, source, audit_chain_id, audit_seq)
         VALUES ($1, $2, 'esign', 1, repeat('a', 64), 'penetration@example.com', 'agree', 'in_app', $2, 1)`,
        [id, orgId],
      );
      return id;
    },
  },
};

/** 傳入系統目錄列出的 org 表名（schema.table），回傳沒有登記案例的表。 */
export function tablesWithoutCase(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in ORG_TABLE_CASES));
}
