// 審核台交易的工單號（withTx 的 operator 脈絡必須帶）。純函式，不依賴 next，流程與測試都能直接 import。
// 格式：desk:<動作>:<ID>，字母數字開頭，64 字內（withTx 的 TICKET_PATTERN）。
export function deskTicket(...parts: string[]): string {
  return ['desk', ...parts].join(':');
}
