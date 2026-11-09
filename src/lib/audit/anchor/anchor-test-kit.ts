import { createHash } from 'node:crypto';
import type { PGliteInterface } from '@electric-sql/pglite';
import { appendAudit } from '../append';
import { ORG_A, ORG_B, asSuperuser, orgCtx, withTriggersOff, type AuditFixture } from '../audit-test-kit';
import type { AuditLogger, AuditLogSeverity } from './audit-log';

// 錨定測試共用的工具。只給 *.test.ts 使用。

export const NOW = new Date('2026-11-10T03:00:00.000Z');

export interface LogEntry {
  severity: AuditLogSeverity;
  message: string;
  fields: Record<string, unknown>;
}

export function memoryLogger(): AuditLogger & { entries: LogEntry[]; of(severity: AuditLogSeverity): LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    of: (severity) => entries.filter((e) => e.severity === severity),
    log: (severity, message, fields = {}) => {
      entries.push({ severity, message, fields });
    },
  };
}

/** 建立 A、B 兩個組織（control.orgs 的目錄列），建鏈不需要，但 verify-audit 靠它列出要驗的鏈。 */
export async function seedOrgs(f: AuditFixture): Promise<void> {
  await asSuperuser(f.db, async () => {
    await f.db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲組織', 'owner'), ($2, '乙組織', 'owner')`, [ORG_A, ORG_B]);
  });
}

/** 在組織的鏈上寫 n 筆事件，回傳最後一筆的位置。 */
export async function writeEvents(f: AuditFixture, orgId: string, n: number) {
  let last = { chainId: '', seq: 0, hash: '' };
  for (let i = 1; i <= n; i++) {
    last = await f.withTx(orgCtx(orgId), (tx) =>
      appendAudit(tx, { action: 'ledger.entry', object: { type: 'ledger', id: `L-${i}` }, payload: { amount: i * 100 } }),
    );
  }
  return last;
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 超級使用者從頭到尾重算整條鏈與鏈頭（ADR-0019 實測表最後一列）：改第 2 筆的動作，之後每一筆重算。
 * 本地驗證會通過，只有外部回執抓得到。
 */
export async function rewriteWholeChain(db: PGliteInterface, chainId: string): Promise<void> {
  await withTriggersOff(db, async () => {
    const { rows } = await db.query<{ seq: string; canonical: string }>(
      `SELECT seq, canonical FROM audit.events WHERE chain_id = $1 ORDER BY seq`,
      [chainId],
    );
    let prev = '0'.repeat(64);
    for (const row of rows) {
      const canonical = Number(row.seq) === 2 ? row.canonical.replace('ledger.entry', 'member.grant') : row.canonical;
      const hash = sha(prev + canonical);
      await db.query(
        `UPDATE audit.events SET canonical = $1, prev_hash = $2, hash = $3,
                action = CASE WHEN seq = 2 THEN 'member.grant' ELSE action END
          WHERE chain_id = $4 AND seq = $5`,
        [canonical, prev, hash, chainId, Number(row.seq)],
      );
      prev = hash;
    }
    await db.query(`UPDATE audit.chain_heads SET head_hash = $1 WHERE chain_id = $2`, [prev, chainId]);
  });
}

/** 超級使用者對錨定表做事，先關掉該表的觸發器。 */
export async function tamperAnchors<T>(db: PGliteInterface, table: 'anchor_batches' | 'anchor_leaves', fn: () => Promise<T>): Promise<T> {
  return asSuperuser(db, async () => {
    await db.exec(`ALTER TABLE audit.${table} DISABLE TRIGGER USER`);
    try {
      return await fn();
    } finally {
      await db.exec(`ALTER TABLE audit.${table} ENABLE TRIGGER USER`);
    }
  });
}
