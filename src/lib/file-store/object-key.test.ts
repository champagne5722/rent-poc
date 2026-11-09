import { describe, expect, it } from 'vitest';
import { buildObjectKey, InvalidObjectKey, parseObjectKey } from './object-key';

describe('buildObjectKey', () => {
  it('組出 org/<org_id>/<area>/<檔名>', () => {
    expect(buildObjectKey('01ORG', 'sign-tasks', '01TASK', 'contract-signed.pdf')).toBe(
      'org/01ORG/sign-tasks/01TASK/contract-signed.pdf',
    );
  });

  it('org_id 在最前面：不同組織的同名檔案 key 不同', () => {
    expect(buildObjectKey('01ORGA', 'uploads', 'a.pdf')).not.toBe(buildObjectKey('01ORGB', 'uploads', 'a.pdf'));
  });

  it.each([
    ['org_id 含斜線', ['01/ORG', 'a', 'f.pdf']],
    ['org_id 是 ..', ['..', 'a', 'f.pdf']],
    ['area 是空字串', ['01ORG', '', 'f.pdf']],
    ['檔名含 ..', ['01ORG', 'a', '..']],
    ['檔名含反斜線', ['01ORG', 'a', 'x\\y.pdf']],
    ['檔名含空白', ['01ORG', 'a', 'x y.pdf']],
    ['沒有檔名', ['01ORG', 'a']],
  ] as [string, string[]][])('拒絕：%s', (_name, args) => {
    expect(() => buildObjectKey(args[0], args[1], ...args.slice(2))).toThrow(InvalidObjectKey);
  });

  it('超過 1024 位元組時拒絕', () => {
    expect(() => buildObjectKey('01ORG', 'a', 'x'.repeat(1100))).toThrow(InvalidObjectKey);
  });
});

describe('parseObjectKey', () => {
  it('接受 buildObjectKey 的結果', () => {
    const key = buildObjectKey('01ORG', 'a', 'b', 'c.pdf');
    expect(parseObjectKey(key)).toBe(key);
  });

  it.each(['', 'org/01ORG/a', 'foo/01ORG/a/b.pdf', 'org/01ORG/a/../b.pdf', '/org/01ORG/a/b.pdf', 'org/01ORG/a/b/'])(
    '拒絕 %j',
    (key) => {
      expect(() => parseObjectKey(key)).toThrow(InvalidObjectKey);
    },
  );
});
