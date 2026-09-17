// Session-scoped markers set when a support session starts, so the banner can
// keep its exit control even while `get-session` is failing.
export const SUPPORT_ACTIVE_KEY = "support:active";
export const SUPPORT_RETURN_KEY = "support:return";

export function clearSupportMarkers() {
  sessionStorage.removeItem(SUPPORT_ACTIVE_KEY);
  sessionStorage.removeItem(SUPPORT_RETURN_KEY);
}

/**
 * End the current support session and go back to the employee account.
 * `returnTo` wins over the console filters saved at start; both fall back to
 * the console root. If the employee session could not be restored, the only
 * option left is signing in again.
 */
export async function exitImpersonation(returnTo?: string) {
  const response = await fetch("/api/auth/support/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error("Could not exit. Please try again.");
  const { restored } = await response.json();
  const saved = sessionStorage.getItem(SUPPORT_RETURN_KEY);
  clearSupportMarkers();
  const destination = returnTo ?? (saved?.startsWith("/admin?") ? saved : "/admin");
  window.location.assign(restored ? destination : "/auth/sign-in");
}
