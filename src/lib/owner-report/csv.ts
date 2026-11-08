// 屋主月報表的 CSV 長格式（ADR-0050 決議 15）。
// UTF-8 加 BOM，行尾 CRLF，欄位依 RFC 4180 加引號，Excel 直接開啟。
// 欄位：區段、租賃單位 ID、門牌、項目、日期、金額、來源、標示、說明。
// 區段的每一列都至少有一行：欄位型區段（抬頭、摘要、租金、押金、代收代付與交付）每個欄位一行，
// 紀錄型區段（需要留意、修繕、入帳與沖銷明細、來源比例、註記）每筆紀錄一行。

import {
  FLAG_DEPOSIT_NOT_HANDED_OVER,
  FLAG_OVERDUE,
  FLAG_REVERSED,
  FUND_KIND_LABELS,
  holderText,
  LEDGER_TYPE_LABELS,
  REPAIR_STATUS_LABELS,
  SOURCE_CSV_VALUES,
} from './labels';
import type { AttentionKind, OwnerReport } from './types';

export const OWNER_REPORT_CSV_COLUMNS = [
  '區段',
  '租賃單位 ID',
  '門牌',
  '項目',
  '日期',
  '金額',
  '來源',
  '標示',
  '說明',
] as const;

export const CSV_SECTIONS = {
  header: '抬頭',
  summary: '摘要',
  attention: '需要留意',
  rent: '租金',
  deposit: '押金',
  repairs: '修繕',
  handovers: '代收代付與交付',
  ledgerDetail: '入帳與沖銷明細',
  sources: '來源比例',
  notes: '註記',
} as const;

export interface CsvRow {
  section: string;
  unitId: string;
  address: string;
  item: string;
  date: string;
  /** 整數新台幣元。沒有金額的列為 null。 */
  amount: number | null;
  source: string;
  flag: string;
  note: string;
}

const ATTENTION_LABELS: Record<AttentionKind, string> = {
  overdue: '逾期',
  deposit_not_handed_over: FLAG_DEPOSIT_NOT_HANDED_OVER,
  handover_delay: '代收交付逾期',
};

function row(section: string, item: string, over: Partial<CsvRow> = {}): CsvRow {
  return { section, unitId: '', address: '', item, date: '', amount: null, source: '', flag: '', note: '', ...over };
}

function percent(basisPoints: number): string {
  return `${Math.floor(basisPoints / 100)}.${String(basisPoints % 100).padStart(2, '0')}%`;
}

function join(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => p !== null && p !== undefined && p !== '').join('，');
}

/** 把報表展開成 CSV 的資料列。 */
export function reportToCsvRows(report: OwnerReport): CsvRow[] {
  const rows: CsvRow[] = [];
  const h = report.header;

  const S = CSV_SECTIONS; // 區段名稱縮寫，下面每列都要用
  rows.push(
    row(S.header, '屋主', { note: `${h.ownerName}（${h.ownerId}）` }),
    row(S.header, '期間', { date: h.periodStart, note: `${h.periodStart} 至 ${h.periodEnd}` }),
    row(S.header, '產出者', { note: `${h.producerLegalTitle} ${h.producerName}` }),
    row(S.header, '報表編號', { note: h.reportId }),
    row(S.header, '產生時間', { note: h.generatedAt }),
    row(S.header, '不可變聲明', { note: h.immutableStatement }),
  );

  const s = report.summary;
  rows.push(
    row(S.summary, '應收租金', { amount: s.rentDue }),
    row(S.summary, '已入帳', { amount: s.received }),
    row(S.summary, '月底累計逾期', { amount: s.overdue, flag: s.overdue > 0 ? FLAG_OVERDUE : '' }),
    row(S.summary, '預收餘額', { amount: s.prepaidBalance }),
    row(S.summary, '押金餘額', { amount: s.depositBalance }),
  );

  for (const a of report.attention) {
    rows.push(
      row(S.attention, ATTENTION_LABELS[a.kind], {
        unitId: a.unitId,
        address: a.address,
        date: a.date,
        amount: a.amount,
        flag: a.flag,
        note: a.note,
      }),
    );
  }

  for (const r of report.rent) {
    const unit = { unitId: r.unitId, address: r.address };
    rows.push(
      row(S.rent, '應收租金', { ...unit, date: r.dueDate ?? '', amount: r.rentDue }),
      row(S.rent, '已入帳', { ...unit, amount: r.received }),
      row(S.rent, '逾期', {
        ...unit,
        date: r.overduePeriods.length > 0 ? r.overduePeriods[0].dueDate : '',
        amount: r.overdue,
        flag: r.overdue > 0 ? FLAG_OVERDUE : '',
        note: r.overduePeriods.length > 0 ? `累計 ${r.overduePeriods.length} 期未足額` : '',
      }),
      row(S.rent, '預收', { ...unit, amount: r.prepaidBalance }),
    );
  }

  for (const d of report.deposit) {
    const unit = { unitId: d.unitId, address: d.address };
    rows.push(
      row(S.deposit, '約定', { ...unit, amount: d.expected }),
      row(S.deposit, '已收', { ...unit, amount: d.received }),
      row(S.deposit, '本月扣抵', { ...unit, amount: d.deducted }),
      row(S.deposit, '本月返還', { ...unit, amount: d.returned }),
      row(S.deposit, '餘額', { ...unit, amount: d.balance }),
      row(S.deposit, '收款帳戶持有人', { ...unit, note: holderText(d) }),
      row(S.deposit, '備註', { ...unit, note: d.remark ?? '' }),
    );
    for (const x of d.deductions) {
      rows.push(
        row(S.deposit, '扣抵明細', {
          ...unit,
          amount: x.amount,
          flag: x.reversed ? FLAG_REVERSED : '',
          note: join([x.reason, x.disputed ? '承租人標示異議' : null]),
        }),
      );
    }
  }

  for (const r of report.repairs) {
    rows.push(
      row(S.repairs, REPAIR_STATUS_LABELS[r.status], {
        unitId: r.unitId,
        address: r.address,
        date: r.reportedAt,
        amount: r.cost,
        note: join([
          r.description,
          r.payer !== null ? `付款方：${r.payer}` : null,
          r.handler !== null ? `處理者：${r.handler}` : null,
          r.closedAt !== null ? `結案日：${r.closedAt}` : null,
        ]),
      }),
    );
  }

  for (const x of report.handovers) {
    const unit = { unitId: x.unitId, address: x.address };
    const kind = FUND_KIND_LABELS[x.fundKind];
    rows.push(
      row(S.handovers, `代收${kind}`, { ...unit, date: x.receivedAt, amount: x.amount }),
      row(S.handovers, `交付${kind}`, {
        ...unit,
        date: x.handedOverAt ?? '',
        amount: x.handedOverAmount,
        flag: x.flag ?? '',
        note: join([
          x.handedOverAt === null ? '尚未交付' : null,
          `交付天數 ${x.elapsedDays} 日`,
          x.agreedDays !== null ? `約定 ${x.agreedDays} 日` : null,
        ]),
      }),
      row(S.handovers, '差額', { ...unit, amount: x.difference, note: x.differenceNote ?? '' }),
    );
  }

  for (const l of report.ledgerDetail) {
    rows.push(
      row(S.ledgerDetail, LEDGER_TYPE_LABELS[l.type], {
        unitId: l.unitId,
        address: l.address,
        date: l.effectiveDate,
        amount: l.amount,
        source: l.source !== null ? SOURCE_CSV_VALUES[l.source] : '',
        flag: l.reversed ? FLAG_REVERSED : '',
        note: join([
          `登錄日 ${l.postedDate}`,
          l.paymentAccountMask !== null ? `收款帳戶 ${l.paymentAccountMask}` : null,
          l.note,
        ]),
      }),
    );
  }

  for (const item of report.sourceBreakdown.items) {
    rows.push(
      row(S.sources, '入帳金額', {
        amount: item.amount,
        source: SOURCE_CSV_VALUES[item.source],
        note: percent(item.basisPoints),
      }),
    );
  }
  rows.push(
    row(S.sources, '合計', {
      amount: report.sourceBreakdown.totalAmount,
      note: report.sourceBreakdown.totalAmount > 0 ? '100.00%' : '0.00%',
    }),
  );

  for (const n of report.notes) rows.push(row(S.notes, '註記', { note: n.text }));

  return rows;
}

// 試算表會把以這些字元開頭的文字當公式執行。純文字欄位前面加單引號擋掉。
const FORMULA_START = /^[=+\-@\t\r]/;

function textCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function amountCell(amount: number | null): string {
  if (amount === null) return '';
  if (!Number.isSafeInteger(amount)) throw new RangeError(`金額必須是安全整數元：${amount}`);
  return String(amount);
}

export const CSV_BOM = '﻿';

/** 長格式 CSV。第一個字元是 BOM（編碼成 UTF-8 是 EF BB BF）。 */
export function reportToCsv(report: OwnerReport): string {
  const lines = [OWNER_REPORT_CSV_COLUMNS.map(textCell).join(',')];
  for (const r of reportToCsvRows(report)) {
    lines.push(
      [
        textCell(r.section),
        textCell(r.unitId),
        textCell(r.address),
        textCell(r.item),
        textCell(r.date),
        amountCell(r.amount),
        textCell(r.source),
        textCell(r.flag),
        textCell(r.note),
      ].join(','),
    );
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
