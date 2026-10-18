import { NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { hashApiKey } from "@/lib/api-keys";

/**
 * Bearer-API-key authentication for the public API surface.
 *
 * The public API is reached two ways and both land here: directly, and through
 * the Python gateway, which forwards the caller's Bearer token rather than
 * exchanging it — so the key is re-validated authoritatively in the one place
 * that owns the key store.
 *
 * This deliberately mirrors `internal/validate-api-key` (same lookup, same
 * rejection reasons, same `lastUseTime` bookkeeping). It is a separate function
 * only because that route is secret-authenticated for server-to-server use and
 * answers `{valid}` with HTTP 200, whereas a public route must answer with a
 * real 401. Any change to what makes a key acceptable belongs in both.
 */

/**
 * What a key is allowed to do.
 *
 * Deliberately two values, not a permission matrix. `ingest` is the credential
 * an instrumented application carries — it must be able to send telemetry and
 * nothing else, because it ships to wherever that application runs. `admin` is
 * everything the project allows. Anything finer is speculation until a real
 * caller needs it.
 */
export type ApiKeyScope = "ingest" | "admin";

/** Narrows an arbitrary stored value; unknown scopes fail closed to `ingest`. */
export function parseScope(value: unknown): ApiKeyScope {
  return value === "admin" ? "admin" : "ingest";
}

/** The project a valid public API key grants access to. */
export interface PublicApiKeyAuth {
  /** Project the key belongs to. Every public request is scoped to this. */
  projectId: string;
  projectName: string;
  workspaceId: string;
  /** The id of the key that authenticated — never the key itself. */
  keyId: string;
  /** What this key may do. */
  scope: ApiKeyScope;
}

export type PublicAuthResult =
  | { ok: true; auth: PublicApiKeyAuth }
  | { ok: false; response: NextResponse };

/**
 * Why a key was refused, before any surface has turned it into HTTP.
 *
 * Kept separate from the response so the two public surfaces can keep their own
 * wire contracts over one implementation of *what makes a key acceptable*.
 * `expired` is reported distinctly even though the Bearer surface deliberately
 * collapses it into a flat "invalid" — the distinction has to exist here for a
 * caller that is allowed to make it, and discarding it is each caller's choice.
 */
export type ApiKeyRejection =
  | "missing_token"
  | "not_found"
  | "project_deleted"
  | "expired"
  | "insufficient_scope";

export type ApiKeyResolution =
  | { ok: true; auth: PublicApiKeyAuth }
  | { ok: false; reason: ApiKeyRejection };

/** `{detail}` is the error shape the public API and its SDK clients expect. */
export function publicError(detail: string, status: number): NextResponse {
  return NextResponse.json({ detail }, { status });
}

/** Reads a Bearer token from the Authorization header. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token === undefined || token === "" ? null : token;
}

/**
 * The one place that decides whether an API-key-authenticated request is
 * acceptable, and which project it may act on.
 *
 * Both *public* API-key surfaces resolve their caller through this function:
 * the Bearer public API (`requireApiKeyProject`, below) and the SDK reporting
 * routes under `/api/public` (`requireEvalApiKeyProject` in `lib/eval/auth.ts`).
 * `internal/validate-api-key` is deliberately not one of them: it is
 * secret-authenticated for server-to-server use, answers `{valid}` with HTTP
 * 200, and still runs its own lookup — reporting the raw stored `scope` for the
 * Python service to enforce on its own routes rather than deciding anything
 * here.
 *
 * It answers with a reason rather than a response because the surfaces do not
 * agree on the wire: the Bearer public API answers `{detail}` and tells an
 * unauthenticated caller nothing about *why*, while the SDK reporting routes
 * under `/api/public` answer `{error}` with their own longer-standing wording.
 * Those are both contracts with shipped clients, so they stay — but the rules
 * behind them must not be able to drift apart, which is what sharing this does.
 *
 * `lastUseTime` is advisory bookkeeping: a failed write must never fail an
 * otherwise valid request, and it is stamped off the critical path so it never
 * delays one either.
 */
export async function resolveApiKeyProject(
  request: Request,
  options: { require?: ApiKeyScope } = {},
): Promise<ApiKeyResolution> {
  const token = bearerToken(request);
  if (token === null) {
    return { ok: false, reason: "missing_token" };
  }

  const accessKey = await prisma.accessKey.findUnique({
    where: { secretHash: hashApiKey(token) },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          deleteTime: true,
          workspace: { select: { id: true } },
        },
      },
    },
  });

  if (!accessKey) {
    return { ok: false, reason: "not_found" };
  }
  if (accessKey.project.deleteTime) {
    return { ok: false, reason: "project_deleted" };
  }
  if (accessKey.expireTime && accessKey.expireTime < new Date()) {
    return { ok: false, reason: "expired" };
  }

  // Stamped before the scope check, not after: the key is genuine and was in
  // fact used, and only the authorization decision below goes against it.
  //
  // Deliberately not awaited. This function runs on every API-key request,
  // including every SDK telemetry report, and the stamp is advisory display
  // data — it has no business adding a write round-trip to the caller's
  // latency. The SDK reporting surface already behaved this way before both
  // surfaces shared one resolver; awaiting it here regressed that path.
  //
  // `.catch` is attached synchronously so a failed write can never surface as
  // an unhandled rejection, `Promise.resolve` tolerates a client that answers
  // with a non-promise, and the `try` covers one that throws outright.
  try {
    void Promise.resolve(
      prisma.accessKey.update({
        where: { id: accessKey.id },
        data: { lastUseTime: new Date() },
      }),
    ).catch(() => {
      // A lost stamp is not worth reporting, let alone failing a request over.
    });
  } catch {
    // As above.
  }

  const scope = parseScope(accessKey.scope);

  if (options.require === "admin" && scope !== "admin") {
    return { ok: false, reason: "insufficient_scope" };
  }

  return {
    ok: true,
    auth: {
      projectId: accessKey.project.id,
      projectName: accessKey.project.name,
      workspaceId: accessKey.project.workspace.id,
      keyId: accessKey.id,
      scope,
    },
  };
}

/**
 * Authenticates a Bearer public API request and resolves the project it may act
 * on.
 *
 * Returns a discriminated result rather than throwing so each route decides how
 * to respond, and so the failure path is impossible to forget.
 *
 * Every *credential* rejection — the key does not exist, has expired, or
 * belongs to a deleted project — is the same flat 401 that says nothing about
 * which of the three it was: telling an unauthenticated caller that much is
 * free reconnaissance. The two refusals that are not about the credential say
 * more, deliberately: a missing Authorization header names itself, because a
 * caller who presented nothing has nothing to learn, and a key that is genuine
 * but under-scoped gets a 403 rather than a 401.
 */
export async function requireApiKeyProject(
  request: Request,
  options: { require?: ApiKeyScope } = {},
): Promise<PublicAuthResult> {
  const result = await resolveApiKeyProject(request, options);
  if (result.ok) {
    return { ok: true, auth: result.auth };
  }

  switch (result.reason) {
    case "missing_token":
      return {
        ok: false,
        response: publicError("Missing or malformed Authorization header", 401),
      };
    // A scope check is an authorization failure, not an authentication one: the
    // key is genuine and the caller should be told plainly what it lacks, rather
    // than being sent to re-authenticate with a credential that will never work.
    case "insufficient_scope":
      return {
        ok: false,
        response: publicError(
          "This API key is scoped to telemetry ingestion and cannot manage project settings.",
          403,
        ),
      };
    default:
      return { ok: false, response: publicError("Invalid API key", 401) };
  }
}
