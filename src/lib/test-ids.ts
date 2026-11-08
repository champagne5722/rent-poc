// 測試用：把小整數轉成合法的 ULID（26 碼，前面補 0）。字典序與數字順序一致，方便寫出可讀的測試資料。
// 不要在正式程式碼用。真實 ID 由 newUlid() 產生。

export const ulidOf = (n: number): string => String(n).padStart(26, '0');
