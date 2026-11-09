// 錨定服務的介面（ADR-0019 決議 9，MIL-88）。只有兩件事：取得回執、驗證回執。
//
// 介面的規則：
// - 送出去的只有樹根（64 位小寫十六進位）。介面收不到任何業務資料，也沒有參數能帶。
// - 回執是不透明的 base64 文字，由 adapter 決定內容。呼叫端只存它，驗證時原樣交回。
// - `anchor` 失敗時丟錯，不重試。重試由下一次排程負責（ADR-0019 決議 10）。
// - `verify` 不連網，也不丟錯：回執損毀、雜湊不符、簽章不符都回 `ok: false` 加原因。
// - `issuedAt` 是服務端記錄的時間。FreeTSA 是 TSA 簽進回執的 genTime，Mock 是注入的時鐘。

export interface IssuedReceipt {
  /** base64。 */
  receipt: string;
  issuedAt: Date;
}

export type AnchorVerdict = { ok: true; issuedAt: Date } | { ok: false; reason: string };

export interface AnchorProvider {
  /** 寫進 `audit.anchor_batches.provider` 的識別，驗證時用它找回對應的 adapter。 */
  readonly id: string;
  anchor(rootHex: string): Promise<IssuedReceipt>;
  verify(rootHex: string, receipt: string): Promise<AnchorVerdict>;
}

export const ROOT_PATTERN = /^[0-9a-f]{64}$/;

export function assertRoot(rootHex: string): void {
  if (!ROOT_PATTERN.test(rootHex)) throw new Error('錨定的樹根必須是 64 位小寫十六進位');
}
