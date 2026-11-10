import { describe, expect, it } from 'vitest';
import { formatFileSize, formatTaipeiDate, formatTaipeiDateTime } from './format';

describe('所有權文件畫面的格式化', () => {
  it('時間固定換成臺北時間', () => {
    expect(formatTaipeiDateTime('2026-11-10T02:00:00Z')).toBe('2026/11/10 10:00');
    expect(formatTaipeiDate('2026-11-09T16:00:00Z')).toBe('2026/11/10');
  });

  it('沒有值或無法解析回破折號', () => {
    expect(formatTaipeiDateTime(null)).toBe('—');
    expect(formatTaipeiDate('不是日期')).toBe('—');
  });

  it('檔案大小：不到 1 MB 用 KB，至少 1 KB', () => {
    expect(formatFileSize(0)).toBe('1 KB');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});
