import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, insertContractWithEvent, setDb } from '@/lib/db';
import type { OrgTx } from '@/lib/pg/with-tx';
import { hasActiveLeaseForProperty, hasContractsForProperty, taipeiToday } from './contract-links';

// MIL-145：物件與合約的接縫。現在是 SQLite 實作，MIL-83 換成 PostgreSQL 時這份測試的案例照用。

const TX = {} as OrgTx; // SQLite 版用不到 tx
const PROPERTY = '01M6Y9JX7PV12QFZJ2JCKRRE61';
const OTHER = '01M6Y9JX7PV12QFZJ2JCKRRE62';

let sqlite: Database.Database;
beforeEach(() => {
  sqlite = new Database(':memory:');
  ensureSchema(sqlite);
  setDb(sqlite);
});
afterEach(() => {
  setDb(null);
  sqlite.close();
});

function add(propertyId: string, status: string, fields: Record<string, unknown>, type: 'lease' | 'management' = 'lease') {
  const id = insertContractWithEvent(
    { property_id: propertyId, fields: JSON.stringify(fields), contract_type: type },
    { type: 'created', actor: 'landlord' },
  );
  sqlite.prepare('UPDATE contracts SET status = ? WHERE id = ?').run(status, id);
}

describe('hasContractsForProperty', () => {
  it('沒有合約是 false，有任何狀態與類型的合約都是 true，別的物件的合約不算', async () => {
    expect(await hasContractsForProperty(PROPERTY, TX)).toBe(false);
    add(OTHER, 'completed', {});
    expect(await hasContractsForProperty(PROPERTY, TX)).toBe(false);
    add(PROPERTY, 'voided', {}, 'management');
    expect(await hasContractsForProperty(PROPERTY, TX)).toBe(true);
  });
});

describe('hasActiveLeaseForProperty', () => {
  const NOW = new Date('2026-11-09T02:00:00Z'); // 台北時間 2026-11-09 10:00

  it('已完成的租賃合約，租期止日當天與之後算未屆滿，前一天算已屆滿', async () => {
    add(PROPERTY, 'completed', { endDate: '2026-11-08' });
    expect(await hasActiveLeaseForProperty(PROPERTY, TX, NOW)).toBe(false);
    add(PROPERTY, 'completed', { endDate: '2026-11-09' });
    expect(await hasActiveLeaseForProperty(PROPERTY, TX, NOW)).toBe(true);
  });

  it('租期止日沒填的已完成合約，保守視為未屆滿', async () => {
    add(PROPERTY, 'completed', {});
    expect(await hasActiveLeaseForProperty(PROPERTY, TX, NOW)).toBe(true);
  });

  it('未完成的狀態與委託管理合約不算', async () => {
    for (const status of ['draft', 'awaiting_tenant', 'awaiting_practitioner', 'awaiting_landlord', 'declined', 'voided']) {
      add(PROPERTY, status, { endDate: '2999-12-31' });
    }
    add(PROPERTY, 'completed', { endDate: '2999-12-31' }, 'management');
    expect(await hasActiveLeaseForProperty(PROPERTY, TX, NOW)).toBe(false);
  });
});

describe('taipeiToday', () => {
  it('用台北時間算日期：UTC 16:00 之後已是台北的隔天', () => {
    expect(taipeiToday(new Date('2026-11-08T15:59:00Z'))).toBe('2026-11-08');
    expect(taipeiToday(new Date('2026-11-08T16:00:00Z'))).toBe('2026-11-09');
  });
});
