import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addCustomEquipmentItem, ensureSchema, getProperty, listEquipmentVocabulary, setDb } from './db';
import { EQUIPMENT_OPTIONS } from './types';

// 資料庫測試一律走 in-memory DB，不碰 data/ 下的檔案
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
});

afterEach(() => {
  setDb(null);
  db.close();
});

/** 直接塞一列物件，equipment 欄位給什麼原樣寫入，用來模擬舊資料 */
function seedProperty(equipmentJson: string): number {
  const result = db
    .prepare("INSERT INTO properties (name, address, equipment) VALUES ('測試物件', '台北市中正區某路 1 號', ?)")
    .run(equipmentJson);
  return Number(result.lastInsertRowid);
}

describe('設備詞彙庫 seed', () => {
  it('開檔即帶入平台預設項目，且都不是自訂', () => {
    const vocabulary = listEquipmentVocabulary();
    expect(vocabulary.map((v) => v.name)).toEqual([...EQUIPMENT_OPTIONS]);
    expect(vocabulary.every((v) => v.is_custom === 0)).toBe(true);
  });

  it('重跑 ensureSchema 不會重複 seed', () => {
    ensureSchema(db);
    ensureSchema(db);
    expect(listEquipmentVocabulary()).toHaveLength(EQUIPMENT_OPTIONS.length);
  });
});

describe('新增自訂項目', () => {
  it('新增後出現在詞彙庫，標記為自訂', () => {
    const added = addCustomEquipmentItem('掃地機器人');
    expect(added).toMatchObject({ name: '掃地機器人', is_custom: 1 });
    expect(listEquipmentVocabulary().some((v) => v.name === '掃地機器人')).toBe(true);
  });

  it('名稱重複回 null，不新增第二筆', () => {
    addCustomEquipmentItem('掃地機器人');
    expect(addCustomEquipmentItem('掃地機器人')).toBeNull();
    expect(listEquipmentVocabulary().filter((v) => v.name === '掃地機器人')).toHaveLength(1);
  });

  it('與平台預設項目同名也算重複', () => {
    expect(addCustomEquipmentItem('冷氣')).toBeNull();
  });

  it('名稱前後空白會被修掉，空字串不收', () => {
    expect(addCustomEquipmentItem('  烘衣機  ')).toMatchObject({ name: '烘衣機' });
    expect(addCustomEquipmentItem('   ')).toBeNull();
  });
});

describe('既有物件設備資料遷移', () => {
  it('舊的字串陣列轉成數量 1 的物件陣列', () => {
    const id = seedProperty('["冷氣","洗衣機"]');
    ensureSchema(db);
    expect(getProperty(id)?.equipment).toEqual([
      { name: '冷氣', quantity: 1 },
      { name: '洗衣機', quantity: 1 },
    ]);
    // 已經改寫進資料庫，不是只在讀取時轉換
    const raw = db.prepare('SELECT equipment FROM properties WHERE id = ?').get(id) as { equipment: string };
    expect(JSON.parse(raw.equipment)).toEqual([
      { name: '冷氣', quantity: 1 },
      { name: '洗衣機', quantity: 1 },
    ]);
  });

  it('詞彙庫沒有的舊名稱補成自訂項目', () => {
    seedProperty('["冷氣","按摩浴缸"]');
    ensureSchema(db);
    const vocabulary = listEquipmentVocabulary();
    expect(vocabulary.find((v) => v.name === '按摩浴缸')).toMatchObject({ is_custom: 1 });
    // 平台預設項目不會被改成自訂
    expect(vocabulary.find((v) => v.name === '冷氣')).toMatchObject({ is_custom: 0 });
  });

  it('已是新格式的資料原樣保留，重跑不會再動', () => {
    const id = seedProperty('[{"name":"冷氣","quantity":2}]');
    ensureSchema(db);
    ensureSchema(db);
    expect(getProperty(id)?.equipment).toEqual([{ name: '冷氣', quantity: 2 }]);
    expect(listEquipmentVocabulary()).toHaveLength(EQUIPMENT_OPTIONS.length);
  });

  it('壞掉的 JSON 正規化成空清單，不讓整頁讀不出來', () => {
    const id = seedProperty('壞掉的資料');
    ensureSchema(db);
    expect(getProperty(id)?.equipment).toEqual([]);
  });
});
