"""Shared authentication dependencies for the public API.

Every public route authenticates through one of three flows defined here (not
inside any one endpoint module, so read routes never import from a sibling
endpoint). Authentication is delegated to the Next.js internal routes, which own
the Postgres/Prisma control-plane data. Pick the annotation that matches the
scope the route needs:

- ``KeyStampedAuth`` — API-key, project-scoped. The ingest credential: requires an
  ``Authorization: Bearer tr-<key>`` API key and resolves the key's fixed
  project/workspace. Use for ingestion and any strictly key-only route.
- ``DualStampedAuth`` — key-or-user, project-scoped reads. Accepts either an API
  key or a user session token; a user credential additionally requires a
  ``project_id`` query parameter (a user login is only meaningful once scoped to
  a project, whereas a key already fixes its project). Use for project-scoped
  read endpoints (traces, detectors, sessions).
- ``AccountStampedAuth`` — user-only, account-scoped. Rejects API keys (403) and
  authenticates a user session token WITHOUT a project. Use for the discovery
  surface that answers "which project?" before one is known —
  ``list_workspaces`` / ``list_projects``.

Each ``*StampedAuth`` annotation stamps the rate-limit identity onto the request
during dependency resolution, so always depend on the stamped variant on a
rate-limited route — never on the unstamped intermediates.
"""

import hashlib
import logging
from dataclasses import dataclass
from typing import Annotated, Literal

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, Query, Request, status

from rest.rate_limit import clear_request_rate_limit_exempt, set_rate_limit_identity
from rest.routers.public.jwks_cache import JwksUnavailableError, get_jwks_cache
from shared.config import settings

logger = logging.getLogger(__name__)

# The CLI presents a short-lived EdDSA JWT (minted by the Next.js app's jwt()
# plugin at /api/cli/token) as its working bearer, verified here OFFLINE against
# the app's JWKS. These issuer/audience constants MUST match the ones the mint
# route stamps (frontend/ui/src/app/api/cli/token/route.ts).
_ACCESS_TOKEN_ISSUER = "traceroot"
_ACCESS_TOKEN_AUDIENCE = "traceroot-api"

# The Next app (which mints the JWT and stamps `iat`/`exp`) and this backend run
# on separate hosts with independent clocks. Without leeway, even a small forward
# skew on the mint host makes `iat` look future-dated and pyjwt rejects every
# token with ImmatureSignatureError. Allow a modest skew both directions; it
# extends the 10-minute token's effective life by at most this much, which is
# negligible against the offline-verify model.
_CLOCK_SKEW_LEEWAY_SECONDS = 60


def _is_api_key_token(token: str) -> bool:
    """Return whether a bearer token is an API key (not a user session token).

    API keys are ``tr-<uuid>``; user session tokens never carry that prefix. The
    check is the security discriminator that keeps a raw API key off the
    user-token endpoint, so it lives in exactly one place. It is case-insensitive
    and ignores surrounding whitespace, so any key-shaped value (``"TR-…"``, a
    stray-space ``" tr-…"``) routes to the API-key validator — where the raw key
    is hashed before it leaves this process — and never to the user endpoint,
    which would POST the raw key unhashed.

    Args:
        token (str): The raw bearer token, already stripped of the ``Bearer``
            scheme.

    Returns:
        bool: ``True`` if the token is API-key-shaped, ``False`` otherwise.
    """
    return token.strip().lower().startswith("tr-")


def _is_jwt(token: str) -> bool:
    """Return whether a bearer token is a JWT (three non-empty dot-segments).

    A session token is an opaque single string with no dots; a JWT is
    ``header.payload.signature``. Called only after :func:`_is_api_key_token`, so
    a ``tr-`` key never reaches here — this discriminates a CLI access JWT from a
    raw session token so each routes to the right validator.

    Args:
        token (str): The raw bearer token, already stripped of the ``Bearer``
            scheme.

    Returns:
        bool: ``True`` if the token is JWT-shaped, ``False`` otherwise.
    """
    parts = token.split(".")
    return len(parts) == 3 and all(parts)


async def _verify_access_jwt(token: str) -> str:
    """Verify a CLI access JWT offline and return its subject (the user id).

    The trust anchor for the CLI JWT path. Pins ``EdDSA`` (rejecting
    ``alg=none``/HS*/RS* and any algorithm-confusion), validates the issuer,
    audience, and expiry, and requires ``sub``. The signing key is resolved by
    ``kid`` from the cached JWKS.

    Args:
        token (str): The raw JWT (already known to be JWT-shaped).

    Returns:
        str: The verified ``sub`` claim (the user id).

    Raises:
        HTTPException: 401 for any verification failure (bad signature, expired,
            wrong issuer/audience, missing claims, unknown/absent/malformed ``kid``); 503
            (fail closed) if the JWKS cannot be fetched.
    """
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid token",
    )

    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError:
        raise invalid from None

    # The header is attacker-controlled JSON, so pin the type too: a non-string
    # kid (e.g. a list) would raise inside the JWKS lookup and turn a bad token
    # into a 500 on the public auth path instead of a 401.
    kid = header.get("kid")
    if not kid or not isinstance(kid, str):
        raise invalid

    try:
        signing_key = await get_jwks_cache().get_signing_key(kid)
    except JwksUnavailableError as e:
        logger.error(f"JWKS unavailable while verifying access token: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    # An unknown kid means the token was signed by a key not in our JWKS — an
    # untrusted signer, not an outage.
    if signing_key is None:
        raise invalid

    try:
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["EdDSA"],
            audience=_ACCESS_TOKEN_AUDIENCE,
            issuer=_ACCESS_TOKEN_ISSUER,
            leeway=_CLOCK_SKEW_LEEWAY_SECONDS,
            options={"require": ["exp", "sub"]},
        )
    except jwt.InvalidTokenError:
        raise invalid from None

    sub = claims.get("sub")
    if not sub or not isinstance(sub, str):
        raise invalid
    return sub


@dataclass
class AuthResult:
    """Result of API key authentication.

    The billing fields drive ingestion gating. The identity fields
    (``project_name``/``workspace_name``/``key_name``/``key_hint``) power the
    ``whoami`` endpoint; they are optional because ``validate-api-key`` may not
    return them, and ingestion does not need them.

    ``kind`` discriminates the credential that produced this result: an API key
    (``"api_key"``, the default so every existing construction stays valid) or a
    user session token (``"user"``). ``user_id``/``role`` are populated only on
    the user path; they are ``None`` for API-key results.

    Which fields are meaningful depends on how the result was constructed:

    - **API key** (``kind="api_key"``): ``project_id``/``workspace_id``/
      ``billing_plan``/``ingestion_blocked`` all resolve to the key's real
      project; the identity fields may be set; ``user_id``/``role`` are ``None``.
    - **User, project-scoped** (``kind="user"`` from a project read):
      ``project_id``/``workspace_id``/``billing_plan``/``user_id``/``role`` are
      real; ``ingestion_blocked`` is always ``True`` (a user token must never
      ingest).
    - **User, account-scoped** (``kind="user"`` from account discovery): only
      ``user_id`` is real. ``project_id``/``workspace_id`` are fabricated empty
      strings and ``billing_plan`` is a fabricated ``"free"`` (an account has no
      single project/workspace/plan); they exist only to satisfy the rate-limit
      keying, which buckets account ops per user.
    """

    project_id: str
    workspace_id: str
    billing_plan: str
    ingestion_blocked: bool
    project_name: str | None = None
    workspace_name: str | None = None
    key_name: str | None = None
    key_hint: str | None = None
    kind: Literal["api_key", "user"] = "api_key"
    user_id: str | None = None
    # Reserved for the Epic B guardrails layer (role-based authorization); no
    # consumer reads it yet, so a new reader need not hunt for one.
    role: str | None = None


async def authenticate_api_key(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthResult:
    """Authenticate the request via the Next.js internal validate-api-key route.

    Expects ``Authorization: Bearer <api_key>``. The raw key is hashed before it
    leaves this process; the full token is never forwarded or logged.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <api_key>",
        )

    api_key = parts[1]
    # SHA256 is appropriate for API keys (high-entropy random UUIDs, not user passwords).
    # codeql[py/weak-sensitive-data-hashing]
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/validate-api-key",
                json={"keyHash": key_hash},
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to validate API key: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        ) from e

    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed",
        )

    if response.status_code != 200:
        logger.error(f"Unexpected response from auth service: {response.status_code}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    # A 200 with a malformed body (non-JSON, or a non-object) is an auth-service
    # error, not a client error — surface a controlled 503, never an uncaught 500.
    try:
        data = response.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from auth service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    if not isinstance(data, dict):
        logger.error("Auth service returned a non-object JSON body")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    if not data.get("valid"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=data.get("error", "Invalid API key"),
        )

    # A valid:true response missing required fields is also malformed → 503.
    try:
        project_id = data["projectId"]
        workspace_id = data["workspaceId"]
        billing_plan = data["billingPlan"]
        ingestion_blocked = data["ingestionBlocked"]
    except KeyError as e:
        logger.error(f"Auth service response missing required field: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    # The subscript above rejects an absent workspaceId, but an empty one would
    # still key every such tenant into one shared ingest bucket. Reject it too,
    # so ingest and the dashboard-read path both guarantee a usable workspace.
    if not workspace_id:
        logger.error("Auth service response has an empty workspaceId")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    # ingestionBlocked gates billing enforcement, so fail closed on a malformed
    # value: a non-bool (or the missing case above) must not be read as "not
    # blocked", which would silently bypass the free-plan ingestion limit.
    if not isinstance(ingestion_blocked, bool):
        logger.error("Auth service returned a non-boolean ingestionBlocked")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    return AuthResult(
        kind="api_key",
        project_id=project_id,
        workspace_id=workspace_id,
        billing_plan=billing_plan,
        ingestion_blocked=ingestion_blocked,
        project_name=data.get("projectName"),
        workspace_name=data.get("workspaceName"),
        key_name=data.get("keyName"),
        key_hint=data.get("keyHint"),
    )


KeyAuth = Annotated[AuthResult, Depends(authenticate_api_key)]


async def authenticate_and_stamp_identity(request: Request, auth: KeyAuth) -> AuthResult:
    """Authenticate, then stamp the workspace/plan onto the request for limiting.

    A thin wrapper over the API-key auth so the rate limiter can key the bucket
    by workspace and resolve the plan tier. It runs during dependency resolution
    — before slowapi evaluates the limit — so ``key_func`` sees the identity on
    ``request.state``. Shared by every enforced public route (ingest + reads).

    Public API-key calls are never the trusted internal service-to-service caller,
    so a clean (non-exempt) baseline is established defensively.

    Args:
        request (Request): Incoming request; its ``state`` is stamped with the
            resolved rate-limit identity.
        auth (KeyAuth): API-key auth dependency resolving the workspace and plan.

    Returns:
        AuthResult: The authenticated result, passed through to the route handler.
    """
    clear_request_rate_limit_exempt()
    set_rate_limit_identity(request, auth.workspace_id, auth.billing_plan)
    return auth


KeyStampedAuth = Annotated[AuthResult, Depends(authenticate_and_stamp_identity)]


async def _post_internal_auth(
    path: str,
    payload: dict,
    *,
    log_label: str,
    invalid_detail: str,
    forbidden_detail: str | None = None,
) -> dict:
    """POST to an internal auth route and return its validated response body.

    Centralises the fail-closed introspection block shared by the user-token
    flows: it performs the httpx POST with the internal secret and maps every
    failure mode to the same controlled status the callers produced inline — a
    network error or any unexpected/malformed 200 becomes 503 (never an uncaught
    500), a 401 becomes 401, and a ``valid: false`` body becomes 401. The raw
    token lives in ``payload`` and is never logged.

    The API-key flow (:func:`authenticate_api_key`) deliberately keeps its own
    copy and does not route through here, so the key path stays byte-identical.

    Args:
        path (str): Internal route path (appended to the UI base URL), e.g.
            ``"/api/internal/validate-user-token"``.
        payload (dict): JSON body to POST (carries the raw token; never logged).
        log_label (str): Human-readable label for error logs (e.g. ``"user token"``).
        invalid_detail (str): Fallback ``detail`` for the ``valid: false`` 401 when
            the response body carries no ``error`` string.
        forbidden_detail (str | None): When set, a 403 from the route is mapped to
            a 403 with this detail (the project-scoped "no access" case). When
            ``None``, a 403 is treated as an unexpected status → 503.

    Returns:
        dict: The parsed ``valid: true`` response body, for the caller to read
            its scope-specific fields from.

    Raises:
        HTTPException: 401 (auth failed / invalid), 403 (``forbidden_detail``
            when provided), or 503 (fail closed) per the mapping above.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}{path}",
                json=payload,
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to validate {log_label}: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        ) from e

    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed",
        )

    # A valid token that simply lacks access to this project — instructive, not a 503.
    if forbidden_detail is not None and response.status_code == 403:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=forbidden_detail,
        )

    if response.status_code != 200:
        logger.error(f"Unexpected response from auth service: {response.status_code}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    # A 200 with a malformed body (non-JSON, or a non-object) is an auth-service
    # error, not a client error — surface a controlled 503, never an uncaught 500.
    try:
        data = response.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from auth service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    if not isinstance(data, dict):
        logger.error("Auth service returned a non-object JSON body")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    if not data.get("valid"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=data.get("error", invalid_detail),
        )

    return data


async def authenticate_user_token(token: str, project_id: str) -> AuthResult:
    """Authenticate a user session token against the internal validate-user-token route.

    Mirrors :func:`authenticate_api_key`'s httpx structure and fail-closed 503
    mapping. The token is a better-auth session token (the CLI's credential), not
    an API key; it is POSTed to the internal route for introspection and is never
    logged. A non-empty ``project_id`` is required — the caller guarantees it.

    Args:
        token (str): The raw user session token to validate. Never logged.
        project_id (str): The project the caller is scoping the request to; sent
            to the internal route so it can check membership and access.

    Returns:
        AuthResult: A ``kind="user"`` result carrying the resolved project,
            workspace, plan, role, and user id. ``ingestion_blocked`` is always
            ``True`` for user credentials (see below).

    Raises:
        HTTPException: 401 for an invalid/expired token, 403 when the token is
            valid but has no access to ``project_id``, and 503 (fail closed) for
            any introspection ambiguity — network error, unexpected status, or a
            malformed/incomplete 200 body.
    """
    data = await _post_internal_auth(
        "/api/internal/validate-user-token",
        {"token": token, "projectId": project_id},
        log_label="user token",
        invalid_detail="Invalid token",
        forbidden_detail=f"No access to project '{project_id}'",
    )

    # Defense-in-depth: a 200 body that explicitly denies access is a contract
    # violation (the route should 403 instead) — never read it as a grant.
    if data.get("hasAccess") is False:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"No access to project '{project_id}'",
        )

    # A valid:true (200) response missing required project fields is malformed → 503.
    try:
        resolved_project_id = data["projectId"]
        workspace_id = data["workspaceId"]
        billing_plan = data["billingPlan"]
        role = data["role"]
        user_id = data["userId"]
    except KeyError as e:
        logger.error(f"Auth service response missing required field: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    # An empty workspaceId would key every such tenant into one shared rate-limit
    # bucket. Reject it too (parity with the API-key path).
    if not workspace_id:
        logger.error("Auth service response has an empty workspaceId")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    return AuthResult(
        kind="user",
        project_id=resolved_project_id,
        workspace_id=workspace_id,
        billing_plan=billing_plan,
        # ingestion is API-key-only: a user session token must never be usable to
        # ingest. Block it defensively even though no route wires user auth to
        # ingest, so the invariant holds regardless of future route wiring.
        ingestion_blocked=True,
        role=role,
        user_id=user_id,
    )


async def authenticate_user_jwt(token: str, project_id: str) -> AuthResult:
    """Authenticate a CLI access JWT for a project-scoped request.

    The JWT establishes identity offline (:func:`_verify_access_jwt`); the
    project-scoped fields a JWT doesn't carry — role, workspace, plan — are then
    resolved for that user id via the internal ``user-project-access`` route. The
    session-token equivalent is :func:`authenticate_user_token`; this returns the
    same ``kind="user"`` project shape.

    Args:
        token (str): The raw JWT (already known to be JWT-shaped). Never logged.
        project_id (str): The project the caller is scoping to.

    Returns:
        AuthResult: A ``kind="user"`` result carrying the resolved project,
            workspace, plan, role, and user id.

    Raises:
        HTTPException: 401 for an invalid token, 403 when the user has no access
            to ``project_id``, and 503 (fail closed) for any JWKS or
            membership-introspection ambiguity.
    """
    user_id = await _verify_access_jwt(token)

    data = await _post_internal_auth(
        "/api/internal/user-project-access",
        {"userId": user_id, "projectId": project_id},
        log_label="cli access token",
        invalid_detail="Invalid token",
        forbidden_detail=f"No access to project '{project_id}'",
    )

    # Defense-in-depth: a 200 body that explicitly denies access is a contract
    # violation (the route should 403 instead) — never read it as a grant.
    if data.get("hasAccess") is False:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"No access to project '{project_id}'",
        )

    # A 200 response missing required project fields is malformed → 503.
    try:
        resolved_project_id = data["projectId"]
        workspace_id = data["workspaceId"]
        billing_plan = data["billingPlan"]
        role = data["role"]
    except KeyError as e:
        logger.error(f"Auth service response missing required field: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    # An empty workspaceId would key every such tenant into one shared rate-limit
    # bucket (parity with the API-key and session-token paths).
    if not workspace_id:
        logger.error("Auth service response has an empty workspaceId")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    return AuthResult(
        kind="user",
        project_id=resolved_project_id,
        workspace_id=workspace_id,
        billing_plan=billing_plan,
        ingestion_blocked=True,
        role=role,
        user_id=user_id,
    )


def _account_result_for_user(user_id: str) -> AuthResult:
    """Build the account-scope AuthResult for a resolved user id.

    Account scope has no single project/workspace/plan — the user id is the
    identity, project/workspace stay empty, and the plan defaults to free (used
    only for per-user rate-limit keying). Shared by the session-token and JWT
    account paths.
    """
    return AuthResult(
        kind="user",
        project_id="",
        workspace_id="",
        billing_plan="free",
        ingestion_blocked=True,
        user_id=user_id,
    )


async def authenticate_public_caller(
    authorization: Annotated[str | None, Header()] = None,
    project_id: Annotated[
        str | None,
        Query(
            description=(
                "Target project for the request. Required when authenticating with a user "
                "session token (a user credential is only meaningful scoped to a project); "
                "for an API key it is optional and, if given, must match the key's project."
            ),
        ),
    ] = None,
) -> AuthResult:
    """Authenticate a public caller by either an API key or a user session token.

    The unified public-API auth dependency. It parses the bearer token exactly
    like :func:`authenticate_api_key`, then discriminates on the ``tr-`` prefix:
    API keys are ``tr-<uuid>``; user session tokens never start with ``tr-``.

    Security invariant: a ``tr-``-prefixed value can never reach
    :func:`authenticate_user_token` — it always routes to the API-key validator.
    Conversely a non-``tr-`` value never reaches the key validator.

    Args:
        authorization (str | None): The ``Authorization: Bearer <token>`` header.
        project_id (str | None): Optional ``project_id`` query parameter. For an
            API key it is an optional cross-check; for a user token it is required
            (a user credential is only meaningful scoped to a project).

    Returns:
        AuthResult: The API-key result (``kind="api_key"``) or the user result
            (``kind="user"``).

    Raises:
        HTTPException: 401 for a missing/malformed header (or failed auth), 400
            when ``project_id`` is missing for a user token or contradicts the
            API key's project, 403/503 per the delegated validators.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <token>",
        )

    token = parts[1]

    # An empty/whitespace-only token is a malformed credential, not an upstream
    # outage — reject it here as 401 rather than letting it reach a validator and
    # surface as a misleading 503.
    if not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header. Expected: Bearer <token>",
        )

    # Discriminate on the shared API-key predicate: a key-shaped value routes to
    # the key validator (which hashes the raw key before it leaves this process),
    # never to the user endpoint, which would POST the raw key unhashed.
    if _is_api_key_token(token):
        # Key path: reuse the existing validator verbatim (do not duplicate it).
        result = await authenticate_api_key(authorization)
        # An API key already fixes its project; a provided project_id may only
        # confirm it, never override it.
        if project_id and project_id != result.project_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="project_id does not match the API key's project",
            )
        return result

    # User path: a user credential is only meaningful scoped to a project.
    if not project_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "project_id query parameter is required for user credentials; "
                "call list_projects to find one."
            ),
        )
    # A JWT-shaped user credential is a CLI access token: verified offline against
    # the JWKS. Anything else is a raw session token: introspected over HTTP.
    if _is_jwt(token):
        return await authenticate_user_jwt(token, project_id)
    return await authenticate_user_token(token, project_id)


_DualAuth = Annotated[AuthResult, Depends(authenticate_public_caller)]


async def authenticate_and_stamp_public_caller(request: Request, auth: _DualAuth) -> AuthResult:
    """Authenticate a public caller, then stamp workspace/plan(/user) for rate limiting.

    The dual-credential analog of :func:`authenticate_and_stamp_identity`: both
    credential kinds carry ``workspace_id`` and ``billing_plan`` for
    project-scoped requests. A user-credential result also carries a
    ``user_id``, which is passed through so the bucket gains a per-user
    dimension (one user's CLI cannot starve a teammate's within the workspace's
    read budget); an API-key result passes ``None`` so its key stays
    byte-identical to before per-user keys existed. It runs during dependency
    resolution — before slowapi evaluates the limit — so ``key_func`` sees the
    identity on ``request.state``.

    Args:
        request (Request): Incoming request; its ``state`` is stamped with the
            resolved rate-limit identity.
        auth (_DualAuth): Dual-credential auth dependency resolving the
            workspace, plan, and (for user credentials) user id.

    Returns:
        AuthResult: The authenticated result, passed through to the route handler.
    """
    clear_request_rate_limit_exempt()
    set_rate_limit_identity(
        request,
        auth.workspace_id,
        auth.billing_plan,
        auth.user_id if auth.kind == "user" else None,
    )
    return auth


DualStampedAuth = Annotated[AuthResult, Depends(authenticate_and_stamp_public_caller)]


async def authenticate_account_caller(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthResult:
    """Authenticate an account-scope caller by a user session token only.

    The discovery surface (``list_workspaces`` / ``list_projects``) answers
    "which project?" *before* a project is known, so it cannot require a
    ``project_id`` the way :func:`authenticate_public_caller` does. It is a
    user-credential-only entry point: an API key (``tr-`` prefix) is
    project-scoped and cannot enumerate an account, so it is rejected with 403.

    The token is validated against the internal ``validate-user-token`` route
    WITHOUT a ``projectId`` — the account scope, where a live session alone is
    sufficient and the route returns ``{valid, userId, email}``. The resulting
    :class:`AuthResult` carries the user identity only; workspace/project fields
    are empty because an account has no single one. The raw token is never logged.

    Args:
        authorization (str | None): The ``Authorization: Bearer <token>`` header.

    Returns:
        AuthResult: A ``kind="user"`` result with ``user_id`` set and
            ``project_id``/``workspace_id`` empty. ``ingestion_blocked`` is
            always ``True`` (a user credential must never ingest).

    Raises:
        HTTPException: 401 for a missing/malformed header or an invalid/expired
            token, 403 when an API key is presented (account ops are user-only),
            and 503 (fail closed) for any introspection ambiguity — network
            error, unexpected status, or a malformed/incomplete 200 body.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <token>",
        )

    token = parts[1]

    # An empty/whitespace-only token is a malformed credential, not an outage.
    if not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header. Expected: Bearer <token>",
        )

    # Account ops are user-credential-only. A key-shaped value (per the shared
    # discriminator) is a project-scoped credential and can never enumerate an
    # account → 403.
    if _is_api_key_token(token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="this operation requires a user login; API keys are project-scoped",
        )

    # A JWT-shaped credential is a CLI access token: verified offline against the
    # JWKS, no introspection call needed (identity is all account scope requires).
    if _is_jwt(token):
        user_id = await _verify_access_jwt(token)
        return _account_result_for_user(user_id)

    # Session-token path: introspect WITHOUT a projectId (no 403 access branch
    # here — a live session alone is sufficient).
    data = await _post_internal_auth(
        "/api/internal/validate-user-token",
        {"token": token},
        log_label="user token",
        invalid_detail="Invalid token",
    )

    # A valid:true account response must carry the user identity; its absence is
    # malformed → 503 (fail closed rather than authenticating an anonymous user).
    user_id = data.get("userId")
    if not user_id:
        logger.error("Auth service response missing userId for account scope")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    return _account_result_for_user(user_id)


_AccountAuth = Annotated[AuthResult, Depends(authenticate_account_caller)]


async def authenticate_and_stamp_account_caller(request: Request, auth: _AccountAuth) -> AuthResult:
    """Authenticate an account-scope caller, then stamp a per-user rate-limit id.

    Account ops have no workspace, so the bucket is keyed per user: an empty
    ``workspace_id`` plus ``auth.user_id`` in the dedicated user slot of
    :func:`set_rate_limit_identity`, which yields the clean key
    ``rl:read:{plan}:{user_id}``. It runs during dependency resolution, before
    slowapi evaluates the limit, so ``key_func`` sees the identity on
    ``request.state``.

    Args:
        request (Request): Incoming request; its ``state`` is stamped with the
            resolved (per-user) rate-limit identity.
        auth (_AccountAuth): Account-scope auth dependency resolving the user id.

    Returns:
        AuthResult: The authenticated result, passed through to the route handler.
    """
    clear_request_rate_limit_exempt()
    # Account-scope ops have no workspace; bucket per user via the user slot.
    set_rate_limit_identity(request, "", auth.billing_plan, auth.user_id)
    return auth


AccountStampedAuth = Annotated[AuthResult, Depends(authenticate_and_stamp_account_caller)]
