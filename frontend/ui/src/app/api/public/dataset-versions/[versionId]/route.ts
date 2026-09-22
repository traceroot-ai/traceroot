import { requireApiKeyProject } from "@/lib/eval/auth";
import { getDatasetVersionPage } from "@/lib/eval/dataset-read";
import { evalReadResponse } from "@/lib/eval/read-result";

type RouteParams = { params: Promise<{ versionId: string }> };

// GET /api/public/dataset-versions/[versionId]?limit=&cursor= — SDK fetches the
// immutable snapshot it will run against. With neither `limit` nor `cursor` that is the
// whole version in one body, which is what the released SDKs rely on; with `limit` it is a
// page of the cases and a cursor for the rest. The read clamps the page size, so once a
// caller asks for a page it is never unbounded.
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
