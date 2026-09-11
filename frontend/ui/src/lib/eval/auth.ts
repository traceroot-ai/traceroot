import { NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { hashApiKey } from "@/lib/api-keys";

/**
 * Resolve the project for an API-key-authenticated request (the SDK reporting
 * surface). Mirrors the trace-ingestion trust model: `Authorization: Bearer
 * tr-…`, hashed and looked up against `AccessKey.secretHash`. Kept in the Next.js
 * app so the reporting path is locally testable without the Python hop.
 */
export async function requireApiKeyProject(
  request: Request,
): Promise<{ projectId: string; error?: never } | { projectId?: never; error: NextResponse }> {
  const authz = request.headers.get("authorization") ?? "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { error: NextResponse.json({ error: "Missing bearer API key" }, { status: 401 }) };
  }
  const secretHash = hashApiKey(match[1].trim());
  const accessKey = await prisma.accessKey.findUnique({
    where: { secretHash },
    select: {
      projectId: true,
      expireTime: true,
      project: { select: { deleteTime: true } },
    },
  });
  if (!accessKey || accessKey.project?.deleteTime) {
    return { error: NextResponse.json({ error: "Invalid API key" }, { status: 401 }) };
  }
  if (accessKey.expireTime && accessKey.expireTime.getTime() < Date.now()) {
    return { error: NextResponse.json({ error: "API key expired" }, { status: 401 }) };
  }
  // Best-effort last-use stamp; never blocks the request.
  void prisma.accessKey
    .update({ where: { secretHash }, data: { lastUseTime: new Date() } })
    .catch(() => {});
  return { projectId: accessKey.projectId };
}
