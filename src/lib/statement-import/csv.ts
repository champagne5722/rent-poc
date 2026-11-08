// 最小的 CSV 斷詞器（RFC 4180）：引號、跳脫引號、引號內換行、CRLF。不依賴套件。

export interface CsvRecord {
  /** 該筆記錄開始的行號，從 1 起算。引號內有換行時，下一筆的行號會跳過它們。 */
  lineNo: number;
  cells: string[];
  /** 這筆記錄的引號直到檔案結尾都沒有關閉。 */
  unterminated: boolean;
}

export function tokenizeCsv(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;
  let line = 1;
  let recordLine = 1;
  let recordStarted = false; // 目前這筆記錄已有內容或已開始

  const endRecord = (unterminated: boolean) => {
    cells.push(field);
    records.push({ lineNo: recordLine, cells, unterminated });
    cells = [];
    field = '';
    fieldStart = true;
    recordStarted = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (!recordStarted) {
      recordLine = line;
      recordStarted = true;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      cells.push(field);
      field = '';
      fieldStart = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord(false);
      line += 1;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  if (inQuotes) endRecord(true);
  else if (recordStarted) endRecord(false);
  return records;
}
