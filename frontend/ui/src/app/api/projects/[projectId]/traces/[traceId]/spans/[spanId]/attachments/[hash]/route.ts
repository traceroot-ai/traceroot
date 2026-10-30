import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess } from "@/lib/auth-helpers";

const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

// Span images are trace data: every request goes to the backend, which applies
// access and retention, and nothing keeps a copy.
export const dynamic = "force-dynamic";

// The SHA-256 of the image bytes, as span references carry it.
const ATTACHMENT_HASH = /^[0-9a-f]{64}$/;
// The only types the backend stores and serves. Anything else is never passed on,
// so this route cannot serve a document under the app's origin.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

type RouteParams = {
  params: Promise<{ projectId: string; traceId: string; spanId: string; hash: string }>;
};

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE_HEADERS });
}

// GET /api/projects/[projectId]/traces/[traceId]/spans/[spanId]/attachments/[hash]
// Streams an image stored for a span. The backend serves it only if that span's
// text references the hash.
async function handleGET(request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, traceId, spanId, hash } = await params;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  // URL parsers normalize standalone dot segments even after percent-encoding.
  if ([traceId, spanId].some((id) => id === "." || id === "..")) {
    return errorResponse("Invalid trace or span ID", 400);
  }
  if (!ATTACHMENT_HASH.test(hash)) {
    return errorResponse("Invalid attachment hash", 400);
  }

  let backendRes: Response;
  try {
    backendRes = await fetch(
      `${BACKEND_INTERNAL_URL}/api/v1/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}/attachments/${hash}`,
      {
        headers: {
          cookie: request.headers.get("cookie") ?? "",
          // The stored bytes are already compressed; asking for them as they are
          // keeps the backend from gzipping them again and keeps their length.
          "accept-encoding": "identity",
        },
        signal: request.signal,
        cache: "no-store",
      },
    );
  } catch (err) {
    console.error("[span-attachment proxy] fetch error:", err);
    return errorResponse("Failed to reach backend", 502);
  }

  const contentType = backendRes.headers.get("content-type") ?? "";
  if (!backendRes.ok || !backendRes.body || !IMAGE_TYPES.has(contentType)) {
    await backendRes.body?.cancel();
    return errorResponse("Attachment unavailable", backendRes.ok ? 502 : backendRes.status);
  }

  const headers = new Headers({
    ...NO_STORE_HEADERS,
    "Content-Type": contentType,
    "Content-Disposition": "inline",
  });
  const contentLength = backendRes.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  return new Response(backendRes.body, { headers });
}
export const GET = withImpersonationPolicy(handleGET);
