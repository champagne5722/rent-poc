import { authorize, checkAccess } from '@/lib/authorize';
import { getMailer } from '@/lib/mailer';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { inviteMember, listMembers, type InviteResult } from '@/lib/orgs/members';

// 組織成員（MIL-106）。列表所有成員都看得到，待處理的邀請只有 admin 看得到。邀請只有 admin 能做。
// 權限一律經 authorize（MIL-108）。邀請拒絕時保留原本的訊息，成員已能看到這個頁面，沒有洩漏問題。

export async function GET(): Promise<Response> {
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'org_member.read', { type: 'org' });
    return jsonOk({ data: { ...(await listMembers(tx, rc)), me: { userId: rc.userId, role: rc.role } } });
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { email?: unknown; role?: unknown } | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');

  let result: InviteResult | undefined;
  const response = await inOrgTxAs(async (tx, rc) => {
    const access = await checkAccess(tx, 'org_member.manage', { type: 'org' });
    if (!access.allowed) {
      result = { status: 'forbidden' };
      return jsonOk(null);
    }
    result = await inviteMember(tx, rc, { email: body.email, role: body.role, now: new Date() });
    return jsonOk(null);
  });
  // 沒登入或不是組織身分時不會走到 callback，response 就是 401 或 403
  if (!result) return response;

  switch (result.status) {
    case 'forbidden':
      return jsonError(403, '只有組織管理員能邀請成員');
    case 'invalid_email':
      return jsonError(400, '請輸入正確的 email');
    case 'invalid_role':
      return jsonError(400, '角色必須是管理員、業務人員或唯讀');
    case 'already_member':
      return jsonError(409, '這個 email 已經是組織成員');
    case 'already_invited':
      return jsonError(409, '這個 email 已經有待處理的邀請');
    case 'invited': {
      // 寄信是外部呼叫，在交易提交之後。寄不出去邀請仍然有效，被邀請者用這個 email 登入就會加入
      let mailed = true;
      try {
        await getMailer().send({
          to: result.email,
          subject: `邀請你加入「${result.orgName}」`,
          text: `你被邀請加入「${result.orgName}」。請用這個 email 登入租房雲端管理平台，登入後會自動加入。`,
          kind: 'org.invite',
        });
      } catch (error) {
        mailed = false;
        console.error('[org] 邀請信寄送失敗', error);
      }
      return jsonOk({ data: { invitationId: result.invitationId, mailed } }, { status: 201 });
    }
  }
}
