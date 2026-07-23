/**
 * Error from the Python trace API, carrying the HTTP status so callers can
 * distinguish a missing resource (404) from a genuine failure. Lives in its
 * own dependency-free module so UI code can `instanceof` it without pulling
 * in the API client (which tests routinely mock wholesale).
 */
export class TraceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TraceApiError";
  }
}
