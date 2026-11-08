// 移交包下載的 HTTP 回應。屋主端與後台的 route handler 共用。
import { HANDOVER_NOT_FOUND, type HandoverPackageDownload } from './org-service';
import type { ServiceResult } from './service';

export function handoverPackageResponse(result: ServiceResult<HandoverPackageDownload>): Response {
  if (!result.ok) {
    const notFound = result.errors.includes(HANDOVER_NOT_FOUND);
    return Response.json({ error: result.errors.join(' ') }, { status: notFound ? 404 : 409 });
  }
  const { filename, bytes } = result.value;
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
