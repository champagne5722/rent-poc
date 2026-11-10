// 所有權文件畫面的格式化函式（MIL-201 畫面段）。純函式，前端與伺服器端都能匯入。
// 時間固定換成臺北時間，不用本機時區與語系：server component 先渲染一次，必須與瀏覽器一致。
// 日期與時間之間固定一個半形空白，不依賴語系的分隔字元。

const DATE_TIME = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const DATE = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function parts(formatter: Intl.DateTimeFormat, date: Date): Record<string, string> {
  return Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
}

/** 例如 2026/11/10 10:00。無法解析回「—」。 */
export function formatTaipeiDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const p = parts(DATE_TIME, date);
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** 例如 2026/11/10。無法解析回「—」。 */
export function formatTaipeiDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const p = parts(DATE, date);
  return `${p.year}/${p.month}/${p.day}`;
}

/** 檔案大小：1 MB 以上顯示 MB（一位小數），否則顯示 KB（至少 1 KB）。 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
