import { jsonError, jsonOk } from '@/lib/http';
import { registerCertificateFlow } from '@/lib/practitioners';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import { formText, readUploads, requirePracticeActor } from '@/lib/practitioners/route';

// 本人登錄或補件證書，並在目前執業主體建立待驗證任職（MIL-111，ADR-0022 決議 9）。
// multipart：certificateKind、certYear、certWord、certSerial、issuedOn、validUntil、startedOn（選填）、files。
// 專任阻擋回 409，訊息固定「此證號已有在職紀錄」，不透露別的組織（P0-05 AC1）。

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePracticeActor('practitioner.register');
  if (!gate.ok) return gate.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, '請求本文必須是表單資料');
  }
  const uploads = await readUploads(form);
  if (!uploads.ok) return uploads.response;

  const result = await registerCertificateFlow(
    gate.actor,
    {
      certificateKind: formText(form, 'certificateKind'),
      certYear: formText(form, 'certYear'),
      certWord: formText(form, 'certWord'),
      certSerial: formText(form, 'certSerial'),
      issuedOn: formText(form, 'issuedOn'),
      validUntil: formText(form, 'validUntil'),
      startedOn: formText(form, 'startedOn'),
      files: uploads.files,
    },
    defaultFlowDeps(),
  );
  switch (result.status) {
    case 'registered':
      return jsonOk(
        {
          data: {
            certificateId: result.certificateId,
            employment: result.employment && {
              id: result.employment.employmentId,
              consentRequired: result.employment.consentRequired,
              notice: result.employment.notice,
            },
            validUntilHint: result.validUntilHint,
          },
        },
        { status: 201 },
      );
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'blocked':
      return jsonError(409, result.message, { extra: { code: 'employment_blocked' } });
    case 'consent_required':
      return jsonError(409, '登錄前請先閱讀並同意證書資料個資告知', { extra: { code: 'consent_required' } });
    case 'entity_not_ready':
      return jsonError(409, '這個組織的執業主體還在審核中，審核完成後才能登錄任職', { extra: { code: 'entity_not_ready' } });
    case 'already_verified':
      return jsonError(409, '這張證書已驗證，不需要再送件。若換公司，請直接建立任職', { extra: { code: 'already_verified' } });
    case 'forbidden':
      return jsonError(403, '只有執業主體組織的成員能登錄證書');
    case 'number_locked':
      return jsonError(409, '還有已驗證的任職，不能更改證號。請先結束任職', { extra: { code: 'number_locked' } });
    case 'conflict':
      return jsonError(409, '資料剛被改動，請重新整理後再送出');
  }
}
