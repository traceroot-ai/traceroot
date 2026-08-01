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
