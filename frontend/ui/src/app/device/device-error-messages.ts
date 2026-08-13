// The device-authorization plugin reuses the single "invalid_request" error
// code for several distinct situations (unknown code, already-approved code,
// not-yet-claimed code), so the short `error` code alone can't tell them
// apart — the human-readable `error_description` text is what disambiguates.
// Matching on that text (rather than a brittle status/response-shape check)
// keeps this working even though the description strings live in the
// installed better-auth package, not in this repo.
export type DeviceErrorLike = {
  error?: string;
  error_description?: string;
};

/**
 * Map a device-authorization plugin error response to a plain-language
 * message for the /device consent page.
 *
 * @param err - The `{ error, error_description }` body returned by the
 *   plugin's device endpoints (verify/approve/deny) on failure.
 * @returns A user-facing sentence describing what went wrong.
 */
export function mapDeviceErrorMessage(err: DeviceErrorLike | null | undefined): string {
  const code = err?.error;
  const description = err?.error_description;

  if (code === "expired_token") {
    return "This code has expired. Go back to your terminal and run the login command again.";
  }
  if (code === "access_denied") {
    return "This code was already opened by a different account and is locked to it. Go back to your terminal and run the login command again to get a fresh code.";
  }
  if (code === "unauthorized") {
    return "You need to sign in again before continuing.";
  }
  if (description?.includes("already processed")) {
    return "This code has already been used.";
  }
  if (description?.includes("not been claimed")) {
    return "This code hasn't been verified yet. Go back and re-enter it.";
  }
  if (description?.includes("Invalid user code")) {
    return "That code doesn't match a pending request. Double-check it and try again.";
  }

  return (
    description || "Something went wrong. Go back to your terminal and run the login command again."
  );
}

/**
 * Whether a device error can be recovered by re-entering a code on this page.
 *
 * Only a mistyped or not-yet-verified code is fixable here. Everything else —
 * a code locked to another account (access_denied), an expired code, or one
 * that's already been used — needs a brand-new code from the CLI, so offering
 * a "Try again" that just re-checks the same dead code would only loop.
 *
 * @param err - The `{ error, error_description }` body from a device endpoint.
 * @returns True if re-entering a code on the consent page can still succeed.
 */
export function isRecoverableDeviceError(err: DeviceErrorLike | null | undefined): boolean {
  const description = err?.error_description ?? "";
  return description.includes("Invalid user code") || description.includes("not been claimed");
}
