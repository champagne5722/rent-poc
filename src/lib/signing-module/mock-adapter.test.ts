import { describe, expect, it } from 'vitest';
import { createMockProvider } from './mock-adapter';

const headers = new Headers();
const event = JSON.stringify({ resource_id: 'mock-1-abc', resource_type: 'task', action_name: 'completed' });

describe('mock adapter 的 webhook', () => {
  it('本機預設接受沒有簽章的事件，方便手動模擬', () => {
    const parsed = createMockProvider().parseWebhook(event, headers);
    expect(parsed.kind).not.toBe('invalid');
  });

  it('部署環境沒有 client secret 能驗簽，非空 webhook 一律拒收', () => {
    const provider = createMockProvider({ rejectWebhookEvents: true });
    expect(provider.parseWebhook(event, headers)).toMatchObject({ kind: 'invalid', status: 401 });
  });

  it('部署環境仍回應空 body 的驗證 ping，點點簽後台才能儲存 webhook URL', () => {
    const provider = createMockProvider({ rejectWebhookEvents: true });
    expect(provider.parseWebhook('', headers)).toEqual({ kind: 'ping' });
  });
});
