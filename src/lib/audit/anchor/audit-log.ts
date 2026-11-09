// 稽核錨定與驗證的 log（ADR-0019 決議 10、13，MIL-88）。
//
// 每筆 log 是一行 JSON，帶 `severity`。Cloud Run 把 stdout 與 stderr 的 JSON 行轉成結構化 log，
// 並用 `severity` 欄位決定等級，維運才能對 ERROR 與 CRITICAL 設不同的告警。
//
// 等級：
// - WARNING：錨定失敗 1 次。排程會自動再試，不需要人處理。
// - ERROR：錨定連續失敗 2 次以上。外部服務可能中斷，未錨定的窗口在擴大。
// - CRITICAL：稽核鏈驗證失敗，或回執與鏈對不上。這是這個系統最高的等級，視為資安事件。
//
// log 只放鏈編號、序號、問題種類與服務商的錯誤訊息。不放事件內容（canonical、payload）。

export type AuditLogSeverity = 'WARNING' | 'ERROR' | 'CRITICAL';

export interface AuditLogger {
  log(severity: AuditLogSeverity, message: string, fields?: Record<string, unknown>): void;
}

export const consoleAuditLogger: AuditLogger = {
  log(severity, message, fields = {}) {
    const line = JSON.stringify({ severity, component: 'audit-anchor', message, ...fields });
    // WARNING 走 warn，其餘走 error。等級以 JSON 的 severity 為準，不看輸出串流
    if (severity === 'WARNING') console.warn(line);
    else console.error(line);
  },
};
