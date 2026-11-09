// 計時器用的日期。業務日期一律是台灣日期（YYYY-MM-DD），不跟著伺服器時區走。
const TAIPEI_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function taipeiToday(now: Date): string {
  return TAIPEI_DATE.format(now);
}
