import { describe, expect, it } from 'vitest';
import { CROSS_SOURCE_DUPLICATE_WINDOW_DAYS, matchStatementRow } from './match';
import type { CaseFacts, ManualReceiptFact, MatchFacts, StatementRow, UnmatchedReason } from './types';

const row = (overrides: Partial<StatementRow> = {}): StatementRow => ({
  lineNo: 2,
  transactionDate: '2026-03-10',
  depositAmount: 20000,
  summary: '轉入',
  counterpartyName: '陳大華',
  counterpartyAccount: '9876543210',
  transactionSerial: null,
  sameDaySeq: 1,
  ...overrides,
});

const completedCase = (overrides: Partial<Extract<CaseFacts, { contractCompleted: true }>> = {}): CaseFacts => ({
  caseId: 'case-1',
  remitterIdentifiers: [{ kind: 'name', value: '陳大華' }],
  paymentAccountIds: ['acct-1'],
  contractCompleted: true,
  deposit: { expectedAmount: 20000, receivedAmount: 0 },
  depositHolderRuleAction: 'allow',
  ...overrides,
});

const facts = (overrides: Partial<MatchFacts> = {}): MatchFacts => ({
  importAccount: { id: 'acct-1', kind: 'general' },
  cases: [completedCase()],
  manualReceipts: [],
  ...overrides,
});

describe('matchStatementRow：六個條件全部成立', () => {
  it('押金未收足且金額等於差額：押金', () => {
    expect(matchStatementRow(row(), facts())).toEqual({
      ok: true,
      caseId: 'case-1',
      purpose: 'security_deposit',
      holderRuleAction: 'allow',
    });
  });
  it('押金分兩次收，第二次等於差額：押金', () => {
    const f = facts({ cases: [completedCase({ deposit: { expectedAmount: 30000, receivedAmount: 20000 } })] });
    expect(matchStatementRow(row({ depositAmount: 10000 }), f)).toMatchObject({ ok: true, purpose: 'security_deposit' });
  });
  it('押金已收足：租金，金額不限', () => {
    const f = facts({ cases: [completedCase({ deposit: { expectedAmount: 20000, receivedAmount: 20000 } })] });
    expect(matchStatementRow(row({ depositAmount: 25000 }), f)).toEqual({
      ok: true,
      caseId: 'case-1',
      purpose: 'rent',
      holderRuleAction: 'allow',
    });
  });
  it('押金超收也算已收足：租金', () => {
    const f = facts({ cases: [completedCase({ deposit: { expectedAmount: 20000, receivedAmount: 30000 } })] });
    expect(matchStatementRow(row({ depositAmount: 12000 }), f)).toMatchObject({ ok: true, purpose: 'rent' });
  });
  it('約定押金為 0：租金', () => {
    const f = facts({ cases: [completedCase({ deposit: { expectedAmount: 0, receivedAmount: 0 } })] });
    expect(matchStatementRow(row({ depositAmount: 12000 }), f)).toMatchObject({ ok: true, purpose: 'rent' });
  });
  it('押金用途遇到 warn：仍配對成功，並回傳動作讓呼叫端處理', () => {
    const f = facts({ cases: [completedCase({ depositHolderRuleAction: 'warn' })] });
    expect(matchStatementRow(row(), f)).toMatchObject({ ok: true, purpose: 'security_deposit', holderRuleAction: 'warn' });
    const g = facts({ cases: [completedCase({ depositHolderRuleAction: 'warn_fix_mandate' })] });
    expect(matchStatementRow(row(), g)).toMatchObject({ ok: true, holderRuleAction: 'warn_fix_mandate' });
  });
  it('租金用途不受押金帳戶規則 block 影響', () => {
    const f = facts({
      cases: [completedCase({ deposit: { expectedAmount: 20000, receivedAmount: 20000 }, depositHolderRuleAction: 'block' })],
    });
    expect(matchStatementRow(row(), f)).toEqual({ ok: true, caseId: 'case-1', purpose: 'rent', holderRuleAction: 'allow' });
  });
  it('多個案件中只命中一個', () => {
    const other = completedCase({ caseId: 'case-2', remitterIdentifiers: [{ kind: 'name', value: '林小美' }] });
    expect(matchStatementRow(row(), facts({ cases: [other, completedCase()] }))).toMatchObject({ ok: true, caseId: 'case-1' });
  });
  it('一個案件的戶名與帳號末五碼同時命中，仍是同一個案件', () => {
    const c = completedCase({
      remitterIdentifiers: [
        { kind: 'name', value: '陳大華' },
        { kind: 'account_last5', value: '43210' },
      ],
    });
    expect(matchStatementRow(row(), facts({ cases: [c] }))).toMatchObject({ ok: true, caseId: 'case-1' });
  });
});

describe('matchStatementRow：匯款識別比對', () => {
  const withIdentifier = (value: string, kind: 'name' | 'account_last5') =>
    facts({ cases: [completedCase({ remitterIdentifiers: [{ kind, value }] })] });

  it.each([
    ['戶名完全相同', row(), '陳大華'],
    ['戶名前後空白', row({ counterpartyName: ' 陳大華 ' }), '陳大華'],
    ['戶名中間有全形空白', row({ counterpartyName: '陳　大華' }), '陳大華'],
    ['英文戶名不分大小寫', row({ counterpartyName: 'CHEN DA-HUA' }), 'chen da-hua'],
    ['全形英文戶名', row({ counterpartyName: 'ＣＨＥＮ' }), 'chen'],
  ])('戶名：%s', (_name, r, identifier) => {
    expect(matchStatementRow(r, withIdentifier(identifier, 'name'))).toMatchObject({ ok: true });
  });

  it.each([
    ['完整帳號的末五碼', '9876543210', '43210'],
    ['遮罩帳號', '***43210', '43210'],
    ['帳號含連字號', '987-654-3210', '43210'],
    ['帳號就是五碼', '43210', '43210'],
  ])('帳號末五碼：%s', (_name, account, identifier) => {
    const r = row({ counterpartyName: '', counterpartyAccount: account });
    expect(matchStatementRow(r, withIdentifier(identifier, 'account_last5'))).toMatchObject({ ok: true });
  });

  it.each([
    ['戶名不同', row({ counterpartyName: '陳大明' }), 'name', '陳大華'],
    ['戶名只含部分字', row({ counterpartyName: '陳大華華' }), 'name', '陳大華'],
    ['列沒有戶名', row({ counterpartyName: '' }), 'name', '陳大華'],
    ['帳號末五碼不同', row({ counterpartyName: '', counterpartyAccount: '9876543211' }), 'account_last5', '43210'],
    ['列沒有帳號', row({ counterpartyName: '', counterpartyAccount: '' }), 'account_last5', '43210'],
    ['列的帳號不足五碼', row({ counterpartyName: '', counterpartyAccount: '3210' }), 'account_last5', '43210'],
    ['戶名識別不拿來比帳號', row({ counterpartyName: '', counterpartyAccount: '陳大華' }), 'name', '陳大華'],
  ] as const)('不命中：%s', (_name, r, kind, identifier) => {
    const result = matchStatementRow(r, withIdentifier(identifier, kind));
    expect(result).toMatchObject({ ok: false, reason: 'no_remitter_match' });
  });

  it('案件沒有匯款識別、完全沒有案件：不命中', () => {
    expect(matchStatementRow(row(), facts({ cases: [completedCase({ remitterIdentifiers: [] })] }))).toMatchObject({
      ok: false,
      reason: 'no_remitter_match',
    });
    expect(matchStatementRow(row(), facts({ cases: [] }))).toMatchObject({ ok: false, reason: 'no_remitter_match' });
  });

  it('兩個案件都命中：不挑，列出命中的案件', () => {
    const second = completedCase({ caseId: 'case-2', remitterIdentifiers: [{ kind: 'account_last5', value: '43210' }] });
    const result = matchStatementRow(row(), facts({ cases: [completedCase(), second] }));
    expect(result).toEqual({
      ok: false,
      reason: 'ambiguous_remitter',
      reasons: ['ambiguous_remitter'],
      ambiguousCaseIds: ['case-1', 'case-2'],
    });
  });

  it('匯款識別格式不合法丟 RangeError', () => {
    expect(() => matchStatementRow(row(), withIdentifier('1234', 'account_last5'))).toThrow(RangeError);
    expect(() => matchStatementRow(row(), withIdentifier('12a45', 'account_last5'))).toThrow(RangeError);
    expect(() => matchStatementRow(row(), withIdentifier('  ', 'name'))).toThrow(RangeError);
  });
});

describe('matchStatementRow：各條件不成立的原因鍵', () => {
  it('條件 1：匯入的是現金收取帳戶', () => {
    const result = matchStatementRow(row(), facts({ importAccount: { id: 'acct-cash', kind: 'cash' } }));
    expect(result).toEqual({ ok: false, reason: 'cash_account', reasons: ['cash_account'] });
  });
  it('條件 1：案件的收款帳戶不是匯入帳戶', () => {
    const result = matchStatementRow(row(), facts({ cases: [completedCase({ paymentAccountIds: ['acct-2'] })] }));
    expect(result).toEqual({
      ok: false,
      reason: 'payment_account_mismatch',
      reasons: ['payment_account_mismatch'],
      caseId: 'case-1',
    });
  });
  it('條件 1：案件沒有登錄收款帳戶（Q1）', () => {
    const result = matchStatementRow(row(), facts({ cases: [completedCase({ paymentAccountIds: [] })] }));
    expect(result).toMatchObject({ ok: false, reason: 'payment_account_mismatch' });
  });
  it('條件 1：案件登錄多個收款帳戶，含匯入帳戶即成立', () => {
    const result = matchStatementRow(row(), facts({ cases: [completedCase({ paymentAccountIds: ['acct-2', 'acct-1'] })] }));
    expect(result).toMatchObject({ ok: true });
  });
  it('條件 2：沒有命中任何案件', () => {
    const result = matchStatementRow(row({ counterpartyName: '路人' }), facts());
    expect(result).toEqual({ ok: false, reason: 'no_remitter_match', reasons: ['no_remitter_match'] });
  });
  it('條件 3：押金未收足但金額不等於差額（少於）', () => {
    const result = matchStatementRow(row({ depositAmount: 15000 }), facts());
    expect(result).toEqual({
      ok: false,
      reason: 'purpose_undeterminable',
      reasons: ['purpose_undeterminable'],
      caseId: 'case-1',
    });
  });
  it('條件 3：押金未收足但金額不等於差額（多於）', () => {
    const result = matchStatementRow(row({ depositAmount: 25000 }), facts());
    expect(result).toMatchObject({ ok: false, reason: 'purpose_undeterminable' });
  });
  it('條件 4：押金帳戶規則 block', () => {
    const result = matchStatementRow(row(), facts({ cases: [completedCase({ depositHolderRuleAction: 'block' })] }));
    expect(result).toEqual({
      ok: false,
      reason: 'deposit_rule_blocked',
      reasons: ['deposit_rule_blocked'],
      caseId: 'case-1',
    });
  });
  it('條件 5：跨來源重複', () => {
    const manual: ManualReceiptFact = { id: 'rc-1', paymentAccountId: 'acct-1', amount: 20000, valueDate: '2026-03-09' };
    const result = matchStatementRow(row(), facts({ manualReceipts: [manual] }));
    expect(result).toEqual({
      ok: false,
      reason: 'possible_duplicate_manual',
      reasons: ['possible_duplicate_manual'],
      caseId: 'case-1',
      duplicateCandidateIds: ['rc-1'],
    });
  });
  it('條件 6：合約尚未完成', () => {
    const incomplete: CaseFacts = {
      caseId: 'case-1',
      remitterIdentifiers: [{ kind: 'name', value: '陳大華' }],
      paymentAccountIds: ['acct-1'],
      contractCompleted: false,
    };
    const result = matchStatementRow(row(), facts({ cases: [incomplete] }));
    expect(result).toEqual({
      ok: false,
      reason: 'contract_incomplete',
      reasons: ['contract_incomplete'],
      caseId: 'case-1',
    });
  });
});

describe('matchStatementRow：跨來源重複的邊界（ADR-0014 決議 8，3 天是假設值）', () => {
  const manual = (overrides: Partial<ManualReceiptFact> = {}): ManualReceiptFact => ({
    id: 'rc-1',
    paymentAccountId: 'acct-1',
    amount: 20000,
    valueDate: '2026-03-10',
    ...overrides,
  });
  const duplicateIds = (m: ManualReceiptFact[], window?: number) => {
    const result = matchStatementRow(row(), facts({ manualReceipts: m }), window === undefined ? undefined : { duplicateWindowDays: window });
    return result.ok ? null : (result.duplicateCandidateIds ?? []);
  };

  it('預設視窗是 3 天', () => {
    expect(CROSS_SOURCE_DUPLICATE_WINDOW_DAYS).toBe(3);
  });
  it.each([
    ['同一天', '2026-03-10', true],
    ['前 3 天', '2026-03-07', true],
    ['後 3 天', '2026-03-13', true],
    ['前 4 天', '2026-03-06', false],
    ['後 4 天', '2026-03-14', false],
  ])('入帳日差距：%s', (_name, valueDate, hit) => {
    expect(duplicateIds([manual({ valueDate })])).toEqual(hit ? ['rc-1'] : null);
  });
  it('金額不同不算', () => {
    expect(duplicateIds([manual({ amount: 20001 })])).toBeNull();
  });
  it('收款帳戶不同不算', () => {
    expect(duplicateIds([manual({ paymentAccountId: 'acct-2' })])).toBeNull();
  });
  it('多筆命中時全部列出，依輸入順序', () => {
    expect(duplicateIds([manual({ id: 'rc-2' }), manual({ id: 'rc-3', valueDate: '2026-03-12' }), manual({ id: 'rc-4', amount: 1 })])).toEqual([
      'rc-2',
      'rc-3',
    ]);
  });
  it('視窗可由呼叫端調整', () => {
    expect(duplicateIds([manual({ valueDate: '2026-03-14' })], 5)).toEqual(['rc-1']);
    expect(duplicateIds([manual({ valueDate: '2026-03-11' })], 0)).toBeNull();
    expect(duplicateIds([manual({ valueDate: '2026-03-10' })], 0)).toEqual(['rc-1']);
  });
  it('沒有命中案件時，仍然列出疑似重複', () => {
    const result = matchStatementRow(row({ counterpartyName: '路人' }), facts({ manualReceipts: [manual()] }));
    expect(result).toEqual({
      ok: false,
      reason: 'no_remitter_match',
      reasons: ['no_remitter_match', 'possible_duplicate_manual'],
      duplicateCandidateIds: ['rc-1'],
    });
  });
});

describe('matchStatementRow：六個條件的窮舉組合', () => {
  // 每個旗標 true 代表該條件成立。總共 2^6 = 64 組。
  const conditions = ['account', 'remitter', 'purpose', 'rule', 'noDuplicate', 'contract'] as const;
  type Flags = Record<(typeof conditions)[number], boolean>;
  const combos: Flags[] = Array.from({ length: 1 << conditions.length }, (_, mask) =>
    Object.fromEntries(conditions.map((name, i) => [name, Boolean(mask & (1 << i))])) as Flags,
  );

  const build = (f: Flags) => {
    const amount = f.purpose ? 20000 : 15000; // 押金未收足，差額 20000
    const caseFacts: CaseFacts = f.contract
      ? completedCase({
          remitterIdentifiers: f.remitter ? [{ kind: 'name', value: '陳大華' }] : [],
          paymentAccountIds: f.account ? ['acct-1'] : ['acct-9'],
          depositHolderRuleAction: f.rule ? 'allow' : 'block',
        })
      : {
          caseId: 'case-1',
          remitterIdentifiers: f.remitter ? [{ kind: 'name', value: '陳大華' }] : [],
          paymentAccountIds: f.account ? ['acct-1'] : ['acct-9'],
          contractCompleted: false,
        };
    const manualReceipts: ManualReceiptFact[] = f.noDuplicate
      ? []
      : [{ id: 'rc-1', paymentAccountId: 'acct-1', amount, valueDate: '2026-03-11' }];
    return { r: row({ depositAmount: amount }), mf: facts({ cases: [caseFacts], manualReceipts }) };
  };

  // 預期結果：依賴關係寫成規格的文字。
  // 沒有命中案件時，帳戶、用途、規則、合約都無從判斷。合約未完成時沒有押金台帳，用途與規則無從判斷。
  // 用途無法判定時，規則無從判斷。跨來源重複只看列本身，永遠可判斷。
  const expectedReasons = (f: Flags): UnmatchedReason[] => {
    const out: UnmatchedReason[] = [];
    if (!f.remitter) out.push('no_remitter_match');
    else {
      if (!f.account) out.push('payment_account_mismatch');
      if (f.contract && !f.purpose) out.push('purpose_undeterminable');
      if (f.contract && f.purpose && !f.rule) out.push('deposit_rule_blocked');
    }
    if (!f.noDuplicate) out.push('possible_duplicate_manual');
    if (f.remitter && !f.contract) out.push('contract_incomplete');
    return out;
  };

  it.each(combos.map((f) => [JSON.stringify(f), f] as const))('%s', (_label, f) => {
    const { r, mf } = build(f);
    const result = matchStatementRow(r, mf);
    const reasons = expectedReasons(f);
    if (reasons.length === 0) {
      expect(result).toMatchObject({ ok: true, caseId: 'case-1', purpose: 'security_deposit' });
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasons).toEqual(reasons);
        expect(result.reason).toBe(reasons[0]);
      }
    }
  });

  it('64 組中只有一組成功', () => {
    const successes = combos.filter((f) => matchStatementRow(build(f).r, build(f).mf).ok);
    expect(successes).toHaveLength(1);
  });
});

describe('matchStatementRow：輸入不合法', () => {
  it.each([
    ['金額不是整數', row({ depositAmount: 100.5 })],
    ['金額為零', row({ depositAmount: 0 })],
    ['金額不是安全整數', row({ depositAmount: 2 ** 53 })],
    ['日期格式錯誤', row({ transactionDate: '115/03/10' })],
  ])('%s丟 RangeError', (_name, r) => {
    expect(() => matchStatementRow(r, facts())).toThrow(RangeError);
  });
  it('押金金額不是整數丟 RangeError', () => {
    const f = facts({ cases: [completedCase({ deposit: { expectedAmount: 20000.5, receivedAmount: 0 } })] });
    expect(() => matchStatementRow(row(), f)).toThrow(RangeError);
  });
  it('手動入帳確認的金額或日期不合法丟 RangeError', () => {
    const bad = { id: 'rc-1', paymentAccountId: 'acct-1', amount: 1.5, valueDate: '2026-03-10' };
    expect(() => matchStatementRow(row(), facts({ manualReceipts: [bad] }))).toThrow(RangeError);
    const badDate = { id: 'rc-1', paymentAccountId: 'acct-1', amount: 20000, valueDate: '2026-02-30' };
    expect(() => matchStatementRow(row(), facts({ manualReceipts: [badDate] }))).toThrow(RangeError);
  });
  it('不改動輸入', () => {
    const f = facts({ manualReceipts: [{ id: 'rc-1', paymentAccountId: 'acct-1', amount: 20000, valueDate: '2026-03-10' }] });
    const snapshot = JSON.stringify(f);
    matchStatementRow(row(), f);
    expect(JSON.stringify(f)).toBe(snapshot);
  });
});
