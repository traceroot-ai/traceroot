import { requireApiKeyProject } from "@/lib/eval/auth";
import { getDatasetVersion } from "@/lib/eval/dataset-read";
import { evalReadResponse } from "@/lib/eval/read-result";

type RouteParams = { params: Promise<{ versionId: string }> };

// GET /api/public/dataset-versions/[versionId] — SDK fetches the immutable
// snapshot it will run against: the version plus its test-case items.
export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { versionId } = await params;
  return evalReadResponse(await getDatasetVersion({ projectId: auth.projectId, versionId }));
}
