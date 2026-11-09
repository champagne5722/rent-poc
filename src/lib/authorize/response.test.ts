import { describe, expect, it } from 'vitest';
import { ACCESS_DENY_REASONS } from '../access';
import { Forbidden, forbiddenResponse, type AuthObject, type ForbiddenReason } from './index';

// Forbidden 對外的 response（P0-02 AC1）。純函式，不需要資料庫。

const bodyOf = async (res: Response) => ({ status: res.status, body: await res.text() });
const ID = '00000000000000000000000001';

const property: AuthObject = { type: 'property', id: ID };
const contract: AuthObject = { type: 'contract', id: ID };
const org: AuthObject = { type: 'org' };

describe('forbiddenResponse', () => {
  it('查不到合約回 404「合約不存在」，查不到物件回 404「物件不存在」', async () => {
    expect(await bodyOf(forbiddenResponse(new Forbidden('object_not_found', 'contract.read', contract)))).toEqual({
      status: 404,
      body: JSON.stringify({ error: '合約不存在' }),
    });
    expect(await bodyOf(forbiddenResponse(new Forbidden('object_not_found', 'property.read', property)))).toEqual({
      status: 404,
      body: JSON.stringify({ error: '物件不存在' }),
    });
  });

  it('不是案件成員（承租人看別人的案件）和查不到一樣回 404', async () => {
    const hidden = await bodyOf(forbiddenResponse(new Forbidden('not_a_member', 'contract.read', contract)));
    const missing = await bodyOf(forbiddenResponse(new Forbidden('object_not_found', 'contract.read', contract)));
    expect(hidden).toEqual(missing);
  });

  it('呼叫者看得到物件、只是不能做，回 403 通用訊息', async () => {
    const res = await bodyOf(forbiddenResponse(new Forbidden('viewer_read_only', 'property.manage', property)));
    expect(res).toEqual({ status: 403, body: JSON.stringify({ error: '沒有權限執行此操作' }) });
  });

  it('組織層動作沒有「不存在」可以裝，回 403', async () => {
    expect((await bodyOf(forbiddenResponse(new Forbidden('role_not_allowed', 'audit.export', org)))).status).toBe(403);
  });

  it('任何原因碼都不會出現在 response body', async () => {
    const reasons: ForbiddenReason[] = [...ACCESS_DENY_REASONS, 'object_not_found'];
    for (const reason of reasons) {
      for (const object of [property, contract, org]) {
        const { body } = await bodyOf(forbiddenResponse(new Forbidden(reason, 'contract.read', object)));
        expect(body, `${reason} / ${object.type}`).not.toContain(reason);
      }
    }
  });
});
