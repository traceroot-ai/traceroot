import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { publicError, requireApiKeyProject } from "@/lib/public-auth";

/**
 * Public project API keys — revoke.
 *
 * Completes the rotation story: `traceroot setup --rotate-key` mints a
 * replacement, verifies it works, and only then revokes the old one. Without a
 * revoke path a rotation leaves the superseded credential live forever.
 */

type RouteParams = { params: Promise<{ keyId: string }> };

// DELETE /api/public/api-keys/{keyId}
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { keyId } = await params;

  const result = await requireApiKeyProject(request, { require: "admin" });
  if (!result.ok) {
    return result.response;
  }

  const key = await prisma.accessKey.findUnique({
    where: { id: keyId },
    select: { id: true, projectId: true },
  });

  // A key in another project is reported as absent rather than forbidden: the
  // caller has no business learning that an id it cannot touch exists.
  if (!key || key.projectId !== result.auth.projectId) {
    return publicError("API key not found", 404);
  }

  // Refusing self-revocation is not paternalism — the request is authenticated
  // BY this key, so honouring it would revoke the caller's own credential
  // mid-flight and make the outcome of any retry ambiguous. Rotation is
  // explicitly mint-verify-then-revoke, which never needs this.
  if (key.id === result.auth.keyId) {
    return publicError(
      "Refusing to revoke the API key used to make this request. Authenticate with a different key.",
      409,
    );
  }

  await prisma.accessKey.delete({ where: { id: keyId } });

  return new NextResponse(null, { status: 204 });
}
