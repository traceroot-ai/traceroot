import { requireApiKeyProject } from "@/lib/eval/auth";
import { getDatasetVersionPage } from "@/lib/eval/dataset-read";
import { evalReadResponse } from "@/lib/eval/read-result";

type RouteParams = { params: Promise<{ versionId: string }> };

// GET /api/public/dataset-versions/[versionId]?limit=&cursor= — SDK fetches the
// immutable snapshot it will run against. With neither `limit` nor `cursor` that is the
// whole version in one body, which is what the released SDKs rely on; with `limit` it is a
// page of the cases and a cursor for the rest.
//
// Two layers bound `limit`, and they behave differently ON PURPOSE. The PUBLISHED contract
// is the gateway's `Query(..., le=1000)`, which REJECTS an out-of-range value with 422 —
// the convention every other public paged read follows, and the better answer, since a
// caller who asked for 999999 learns their request was not honoured instead of silently
// receiving 1000. The clamp inside the shared read (`getDatasetVersionPage`) is a BACKSTOP
// for a request that reaches the control plane without passing the gateway (dev, or an
// internal caller): it keeps the response bounded rather than erroring, because by that
// point nobody is reading the status code as a contract. Once a caller asks for a page,
// neither layer will return an unbounded one.
export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { versionId } = await params;
  const url = new URL(request.url);
  return evalReadResponse(
    await getDatasetVersionPage({
      projectId: auth.projectId,
      versionId,
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
    }),
  );
}
