// 門牌正規化純函式（ADR-0025 決議 10，MIL-147）。
// 輸入原始門牌字串，輸出正規化字串、比對用門牌與拆解結構。不碰資料庫與時間。
import { NUMERAL_CLASS, foldWidthAndVariants, numeralToArabic, stripLeadingZeros } from './text';

export interface AddressParts {
  county: string | null;
  district: string | null;
  village: string | null;
  neighborhood: string | null;
  road: string | null;
  section: string | null;
  lane: string | null;
  alley: string | null;
  number: string | null;
  subNumber: string | null;
  floor: string | null;
  floorSub: string | null;
  room: string | null;
  // 拆不出的字，保留原字。
  rest: string | null;
}

export interface NormalizedAddress {
  // 去掉縣市與鄉鎮市區後的完整正規化門牌（含樓層、室號、拆不出的字）。
  normalized: string;
  // 比對用門牌：到「號」為止，不含樓層與室。
  doorplate: string;
  parts: AddressParts;
}

const COUNTIES = [
  '臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市', '基隆市', '新竹市', '嘉義市',
  '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣',
  '臺東縣', '澎湖縣', '金門縣', '連江縣', '桃園縣', '臺北縣', '臺中縣', '臺南縣', '高雄縣',
];

const SEP = '|';
const NAME_STOP = '路街巷弄段號樓';
const DASHES = /[‐‑‒–—―−﹣－~～]/g;
const PUNCTUATION = /[。，、,.;；:：·．'"「」『』()（）]/g;
// 行政區名稱後面緊接「N 路」代表其實是路名（例如「園區二路」），不能當行政區。
const ROAD_AHEAD = new RegExp(`^(?:\\d|${NUMERAL_CLASS})*(?:路|街|大道)`);
const DISTRICT = new RegExp(`^([^\\d${NAME_STOP}]{1,3}?)([區鄉鎮市])`);
const VILLAGE = new RegExp(`^([^\\d${NAME_STOP}]{1,4}?[村里])(?:(\\d+)鄰)?`);
const ROAD = new RegExp(`^([^\\d${NAME_STOP}]+?(?:大道|路|街))`);
const BODY = new RegExp(
  '^(?:(\\d+)段)?(?:(\\d+)巷)?(?:(\\d+)弄)?' +
    '(?:(\\d+)(?:[之-](\\d+))?號(?:之(\\d+))?)?' +
    `\\${SEP}?` +
    '(?:(B?\\d+)(?:樓|F|層)(?:[之-](\\d+))?)?' +
    `\\${SEP}?` +
    '(?:([A-Z0-9]+(?:-\\d+)?)[室房])?',
);

const EMPTY_PARTS: AddressParts = {
  county: null, district: null, village: null, neighborhood: null, road: null, section: null,
  lane: null, alley: null, number: null, subNumber: null, floor: null, floorSub: null,
  room: null, rest: null,
};

function num(value: string | undefined): string | null {
  return value ? stripLeadingZeros(value) : null;
}

function prepare(raw: string): string {
  let text = foldWidthAndVariants(raw).replace(DASHES, '-').replace(PUNCTUATION, '').trim();
  text = text.toUpperCase();
  // 數字與數字之間的空白保留成分隔符，其餘空白全部去掉。
  text = text.replace(/(?<=\d)\s+(?=\d)/g, SEP).replace(/\s+/g, '');
  // 國字數字只在後面接段巷弄號樓鄰室房層 F，或前面是「之」時轉換，避免路名（中山二路）被改。
  const numerals = new RegExp(
    `(${NUMERAL_CLASS}+)(?=[段巷弄號樓鄰室房層F])|(?<=之)(${NUMERAL_CLASS}+)`,
    'g',
  );
  text = text.replace(numerals, (m) => numeralToArabic(m));
  return text.replace(/地下(\d+)/g, 'B$1');
}

export function normalizeAddress(raw: string): NormalizedAddress {
  const parts: AddressParts = { ...EMPTY_PARTS };
  let text = prepare(raw ?? '');

  const county = COUNTIES.find((c) => text.startsWith(c));
  if (county) {
    parts.county = county;
    text = text.slice(county.length);
  }

  const d = DISTRICT.exec(text);
  if (d) {
    let end = d[0].length;
    // 「前鎮區」「新市區」：鎮或市後面緊接「區」時，區是行政區名稱的一部分。
    if (d[2] !== '區' && text[end] === '區') end += 1;
    const after = text.slice(end);
    // 沒有縣市時，後面要接得出路名才當行政區，避免「某某社區」被吃掉。
    if (!ROAD_AHEAD.test(after) && (county || ROAD.test(after))) {
      parts.district = text.slice(0, end);
      text = text.slice(end);
    }
  }

  const v = VILLAGE.exec(text);
  let village: string | null = null;
  let neighborhood: string | null = null;
  if (v && !ROAD_AHEAD.test(text.slice(v[0].length))) {
    village = v[1];
    neighborhood = num(v[2]);
    text = text.slice(v[0].length);
  }

  const r = ROAD.exec(text);
  if (r) {
    parts.road = r[1];
    text = text.slice(r[0].length);
  } else if (village) {
    parts.village = village;
    parts.neighborhood = neighborhood;
  }
  // 有路名時，村里鄰不納入正規化（同一門牌可能有不同村里寫法）。

  const m = BODY.exec(text);
  if (m) {
    parts.section = num(m[1]);
    parts.lane = num(m[2]);
    parts.alley = num(m[3]);
    parts.number = num(m[4]);
    parts.subNumber = num(m[5] ?? m[6]);
    parts.floor = m[7] ? m[7].replace(/^(B?)0+(?=\d)/, '$1') : null;
    parts.floorSub = num(m[8]);
    parts.room = m[9] ?? null;
    text = text.slice(m[0].length);
  }

  // 沒有「號」但有路名時，結尾的裸數字視為門牌號。
  if (!parts.number && parts.road) {
    const bare = /^(\d+)(?:[之-](\d+))?$/.exec(text);
    if (bare) {
      parts.number = num(bare[1]);
      parts.subNumber = num(bare[2]);
      text = '';
    }
  }

  const rest = text.split(SEP).join('');
  parts.rest = rest === '' ? null : rest;

  const doorplate = buildDoorplate(parts);
  const normalized = buildNormalized(parts, doorplate);
  return { normalized, doorplate: doorplate === '' ? (parts.rest ?? '') : doorplate, parts };
}

function buildDoorplate(p: AddressParts): string {
  let out = '';
  if (p.village) out += p.village + (p.neighborhood ? `${p.neighborhood}鄰` : '');
  if (p.road) out += p.road;
  if (p.section) out += `${p.section}段`;
  if (p.lane) out += `${p.lane}巷`;
  if (p.alley) out += `${p.alley}弄`;
  if (p.number) out += p.number + (p.subNumber ? `之${p.subNumber}` : '') + '號';
  return out;
}

function buildNormalized(p: AddressParts, doorplate: string): string {
  let out = doorplate;
  if (p.floor) out += `${p.floor}樓` + (p.floorSub ? `之${p.floorSub}` : '');
  if (p.room) out += `${p.room}室`;
  if (p.rest) out += p.rest;
  return out;
}
