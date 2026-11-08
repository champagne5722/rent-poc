// 門牌文字的共用轉換：全形轉半形、異體字、國字數字。模組內部使用，不從 index 匯出。

// 國字數字字元：小寫、大寫、零的各種寫法，以及「兩」。
const DIGITS: Record<string, number> = {
  零: 0, 〇: 0, '○': 0, 一: 1, 壹: 1, 二: 2, 貳: 2, 兩: 2, 三: 3, 參: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陸: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const UNITS: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };

export const NUMERAL_CLASS = '[零〇○一壹二貳兩三參四肆五伍六陸七柒八捌九玖十拾百佰千仟]';

// 國字數字轉阿拉伯數字字串。
// 有位數字（十、百、千）時照位數計算，例如「一百零五」是 105、「十二」是 12。
// 沒有位數字時逐位轉換，例如「二八三」是 283、「一○五」是 105。
export function numeralToArabic(text: string): string {
  const chars = [...text];
  if (!chars.some((ch) => ch in UNITS)) {
    return chars.map((ch) => String(DIGITS[ch] ?? ch)).join('');
  }
  let total = 0;
  let current = 0;
  for (const ch of chars) {
    if (ch in UNITS) {
      total += (current || 1) * UNITS[ch];
      current = 0;
    } else {
      current = DIGITS[ch] ?? 0;
    }
  }
  return String(total + current);
}

// 全形轉半形（NFKC），並把常見異體字統一：「台」轉「臺」、「巿」轉「市」。
export function foldWidthAndVariants(text: string): string {
  return text.normalize('NFKC').replace(/台/g, '臺').replace(/巿/g, '市');
}

// 去掉數字字串的前導零，保留單一個 0。
export function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '');
}

// 樓層或房號欄位的正規化，供疑似重複比較使用。
// 規則：全形轉半形、去空白、轉大寫、國字數字轉阿拉伯數字、
// 「地下 N」與「BN」統一為 BN、去掉結尾的「樓」「F」「室」「房」、去掉前導零。
export function normalizeUnitToken(value: string | null | undefined): string {
  if (value == null) return '';
  let text = foldWidthAndVariants(value).replace(/\s+/g, '').toUpperCase();
  text = text.replace(new RegExp(`${NUMERAL_CLASS}+`, 'g'), (m) => numeralToArabic(m));
  text = text.replace(/^地下/, 'B');
  text = text.replace(/(樓|F|室|房|層)$/, '');
  return text.replace(/^(B?)0+(?=\d)/, '$1');
}
