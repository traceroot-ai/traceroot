/**
 * Error from the API layer, carrying the HTTP status so callers can
 * distinguish a missing resource (404) or an entitlement refusal (403) from a
 * genuine failure. Lives in its own dependency-free module so UI code can
 * `instanceof` it without pulling in the API client (which tests routinely
 * mock wholesale); the client re-exports it for callers that already import
 * from there.
 */
export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    const message = typeof detail === "string" ? detail : `API error: ${status}`;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** Only policy-tagged responses qualify; ordinary 403s retain their existing UX. */
export class ImpersonationError extends ApiError {
  constructor(message: string) {
    super(403, message);
    this.name = "ImpersonationError";
  }
}

const impersonationMessages: Record<string, string> = {
  "Credentials are unavailable while impersonating":
    "API keys cannot be viewed or managed while impersonating, including as an admin.",
  "Provider credentials are unavailable while impersonating":
    "Providers cannot be added, changed, deleted, or tested while impersonating, including as an admin.",
  "Integration authorization is unavailable while impersonating":
    "Integrations cannot be managed while impersonating, including as an admin.",
  "Read-only while impersonating":
    "This impersonation session is read-only. Changes are not allowed.",
  "Exit impersonation before managing accounts or credentials":
    "Accounts and credentials cannot be managed while impersonating. Exit impersonation to return to your own account.",
};

export async function throwIfImpersonationDenied(response: Response): Promise<void> {
  if (response.status !== 403) return;
  const kind = response.headers?.get("x-impersonation-denied");
  if (kind !== "policy" && kind !== "ended") return;
  if (kind === "ended") {
    throw new ImpersonationError(
      "Impersonation has ended. Select Stop to return to your own account.",
    );
  }
  // Preserve the body for existing error handlers on all other responses.
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  throw new ImpersonationError(
    impersonationMessages[body?.error] ?? "This action is not allowed while impersonating.",
  );
}
