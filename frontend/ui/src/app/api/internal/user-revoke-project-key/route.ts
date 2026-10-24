import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { revokeProjectAccessKey } from "@/lib/revoke-access-key";

const revokeKeySchema = z.object({
  userId: z.string().min(1, "userId is required"),
  projectId: z.string().min(1, "projectId is required"),
  keyId: z.string().min(1, "keyId is required"),
});

// POST /api/internal/user-revoke-project-key
//
// Revokes a project API key for a userId the caller has ALREADY authenticated:
// the undo of user-create-project-key, so a setup run that fails after minting
// can take its keys back. `/api/public/api-keys/{id}` cannot, because it
// authenticates with an admin key of that project and refuses to revoke the key
// making the request.
//
// The rule is the dashboard's own, not a copy of it: `revokeProjectAccessKey`
// is what `api/projects/[projectId]/api-keys/[keyId]` runs, so a login revokes
// exactly what it could revoke in the browser. Trust is the X-Internal-Secret
// plus the backend's verified identity. Never log ids.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = revokeKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { userId, projectId, keyId } = parsed.data;
  const revokeResult = await revokeProjectAccessKey(userId, projectId, keyId);
  if (revokeResult.error) return revokeResult.error;

  return NextResponse.json({ deleted: true }, { status: 200 });
}
