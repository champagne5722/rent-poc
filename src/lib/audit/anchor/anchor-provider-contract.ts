import { describe, expect, it } from 'vitest';
import type { AnchorProvider } from './provider';

// AnchorProvider 的契約測試（ADR-0019 決議 9，MIL-88）。每個 adapter 都要通過同一組。
// 只給 *.test.ts 使用，比照 with-tx-contract.ts。
//
// 契約只涵蓋介面承諾的行為。各 adapter 專屬的情境（Mock 的失敗注入、FreeTSA 的簽章與信任鏈）
// 在各自的測試檔。

const ROOT = '6372fd8017d79479bf568ccf1a6195bbca1db2d578b8d68b25e6ca68ebcf6ebc';
const OTHER_ROOT = '521e1fdb035b141cd547431af299dc45443da2667003d9affe63361fee523f20';

export interface ContractSubject {
  provider: AnchorProvider;
  /** 目前時間，給契約檢查 issuedAt 的合理性。 */
  now: Date;
}

export function describeAnchorProviderContract(name: string, create: () => ContractSubject | Promise<ContractSubject>): void {
  describe(`AnchorProvider 契約：${name}`, () => {
    it('有穩定的 id', async () => {
      const { provider } = await create();
      expect(provider.id).toMatch(/^[a-z][a-z0-9-]*$/);
    });

    it('anchor 回傳 base64 的回執與時間', async () => {
      const { provider, now } = await create();
      const issue = await provider.anchor(ROOT);
      expect(issue.receipt.length).toBeGreaterThan(0);
      expect(Buffer.from(issue.receipt, 'base64').toString('base64')).toBe(issue.receipt);
      expect(issue.issuedAt).toBeInstanceOf(Date);
      expect(Math.abs(issue.issuedAt.getTime() - now.getTime())).toBeLessThan(60_000);
    });

    it('verify 接受自己簽出的回執，並回傳同一個時間', async () => {
      const { provider } = await create();
      const issue = await provider.anchor(ROOT);
      const verdict = await provider.verify(ROOT, issue.receipt);
      expect(verdict).toEqual({ ok: true, issuedAt: issue.issuedAt });
    });

    it('verify 拒絕別的樹根', async () => {
      const { provider } = await create();
      const issue = await provider.anchor(ROOT);
      const verdict = await provider.verify(OTHER_ROOT, issue.receipt);
      expect(verdict.ok).toBe(false);
    });

    it('verify 對損毀的回執回傳 ok: false，不丟錯', async () => {
      const { provider } = await create();
      const issue = await provider.anchor(ROOT);
      const bytes = Buffer.from(issue.receipt, 'base64');
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      for (const bad of [bytes.toString('base64'), '', 'not base64 !!', Buffer.from('{}').toString('base64')]) {
        const verdict = await provider.verify(ROOT, bad);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0);
      }
    });

    it('anchor 拒絕不是 64 位小寫十六進位的樹根', async () => {
      const { provider } = await create();
      await expect(provider.anchor('xyz')).rejects.toThrow(/64 位/);
      await expect(provider.anchor(ROOT.toUpperCase())).rejects.toThrow(/64 位/);
    });
  });
}
