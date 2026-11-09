// 台灣日期（Asia/Taipei），YYYY-MM-DD。registry-rules 的純函式一律收這種字串。
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });

export function taiwanDate(at: Date): string {
  return formatter.format(at);
}
