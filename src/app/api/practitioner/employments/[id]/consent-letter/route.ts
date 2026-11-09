import { jsonError, jsonOk } from '@/lib/http';
import { submitConsentLetterFlow } from '@/lib/practitioners';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import { readUploads, requirePracticeActor } from '@/lib/practitioners/route';

type Ctx = { params: Promise<{ id: string }> };

// 經紀人員掛第二家時上傳所屬業者的同意書（MIL-111，P0-05 AC3）。multipart：files。

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
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

  const result = await submitConsentLetterFlow(gate.actor, id, { files: uploads.files }, defaultFlowDeps());
  switch (result.status) {
    case 'submitted':
      return jsonOk({ data: { itemId: result.itemId } }, { status: 201 });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'not_found':
      return jsonError(404, '找不到這個任職');
    case 'not_required':
      return jsonError(409, '這個任職不需要同意書，或同意書已核對');
    case 'forbidden':
      return jsonError(403, '只有執業主體組織的成員能上傳同意書');
    case 'conflict':
      return jsonError(409, '資料剛被改動，請重新整理後再送出');
  }
}
