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

  it('同組織 viewer 寫入、角色不夠、狀態不允許，對有 ID 的物件也回「不存在」（ADR-0023 決議 6）', async () => {
    for (const reason of ['viewer_read_only', 'role_not_allowed', 'state_not_allowed', 'not_a_member', 'no_case'] as const) {
      const denied = await bodyOf(forbiddenResponse(new Forbidden(reason, 'contract.draft_send', contract)));
      const missing = await bodyOf(forbiddenResponse(new Forbidden('object_not_found', 'contract.draft_send', contract)));
      expect(denied, reason).toEqual(missing);
    }
    const deniedProperty = await bodyOf(forbiddenResponse(new Forbidden('viewer_read_only', 'property.manage', property)));
    expect(deniedProperty).toEqual({ status: 404, body: JSON.stringify({ error: '物件不存在' }) });
  });

  it('物件是組織本身時沒有「不存在」可以裝，回 403 通用訊息', async () => {
    expect(await bodyOf(forbiddenResponse(new Forbidden('role_not_allowed', 'audit.export', org)))).toEqual({
      status: 403,
      body: JSON.stringify({ error: '沒有權限執行此操作' }),
    });
    expect((await bodyOf(forbiddenResponse(new Forbidden('viewer_read_only', 'property.manage', org)))).status).toBe(403);
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
