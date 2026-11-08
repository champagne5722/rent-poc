import { describe, expect, it } from 'vitest';
import { addDays, addMonths, addYears, isIsoDate } from './dates';

describe('isIsoDate', () => {
  it.each([
    ['2026-11-08', true],
    ['2028-02-29', true],
    ['2027-02-29', false],
    ['2026-13-01', false],
    ['2026-1-8', false],
    ['2026-11-08T00:00:00Z', false],
    ['', false],
  ])('%s -> %s', (input, expected) => {
    expect(isIsoDate(input)).toBe(expected);
  });
});

describe('addDays', () => {
  it.each([
    ['2027-08-31', -30, '2027-08-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-03-01', -1, '2028-02-29'],
  ])('%s %i 天 -> %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe('addMonths', () => {
  it.each([
    ['2027-08-31', -6, '2027-02-28'], // 月底截到當月最後一天
    ['2027-08-15', -6, '2027-02-15'],
    ['2026-05-08', 6, '2026-11-08'],
    ['2026-08-31', 6, '2027-02-28'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2026-11-08', 14, '2028-01-08'],
  ])('%s %i 月 -> %s', (date, months, expected) => {
    expect(addMonths(date, months)).toBe(expected);
  });
});

describe('addYears', () => {
  it.each([
    ['2026-11-08', 4, '2030-11-08'],
    ['2024-02-29', 4, '2028-02-29'],
    ['2024-02-29', 1, '2025-02-28'],
  ])('%s %i 年 -> %s', (date, years, expected) => {
    expect(addYears(date, years)).toBe(expected);
  });
});

describe('非法日期', () => {
  it('拋 RangeError', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addMonths('abc', 1)).toThrow(RangeError);
    expect(() => addYears('2026-13-01', 1)).toThrow(RangeError);
  });
});
