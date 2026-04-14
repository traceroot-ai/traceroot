/**
 * Helper functions for validating GitHub OAuth callback requests.
 */

export interface CallbackParams {
  code: string | null;
  state: string | null;
  installationId: string | null;
  setupAction: string | null;
  storedState: string | null;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  isDirectGitHubInstall: boolean;
}

/**
 * Validates the parameters of a GitHub OAuth callback request.
 *
 * There are two valid scenarios:
 * 1. Normal OAuth flow: User started from our app, state cookie exists and matches
 * 2. Direct GitHub install: User installed app directly from GitHub, no state cookie,
 *    but has setup_action=install and installation_id
 *
 * Security guarantees for direct install flow:
 * - OAuth code is still validated by GitHub when exchanged for token
 * - Installation ID must be verified to belong to the authenticated GitHub user
 * - User must be logged into the app (checked separately)
 * - Only bypasses state check if NO state cookie exists
 */
export function validateCallbackParams(params: CallbackParams): ValidationResult {
  const { code, state, installationId, setupAction, storedState } = params;

  // code is always required
  if (!code) {
    return {
      valid: false,
      error: "Missing code or state parameter",
      isDirectGitHubInstall: false,
    };
  }

  // Detect direct GitHub install: user installed app from GitHub's UI,
  // not through our OAuth flow. In this case:
  // - setupAction is "install"
  // - installationId is present
  // - No state cookie was set (because we didn't initiate the flow)
  // - state may be absent (GitHub doesn't send it for direct installs)
  // Also require !state: GitHub's direct install flow never sends a state param.
  // Requiring its absence avoids mis-classifying a TraceRoot-initiated install
  // with a stale/mismatched cookie as a direct install.
  const isDirectGitHubInstall =
    setupAction === "install" && !!installationId && !storedState && !state;

  // For direct GitHub installs, skip the state check — GitHub doesn't include
  // a state parameter when the user installs from GitHub's UI directly.
  if (isDirectGitHubInstall) {
    return {
      valid: true,
      isDirectGitHubInstall: true,
    };
  }

  // For normal OAuth flow: state is required and must match the stored cookie
  if (!state) {
    return {
      valid: false,
      error: "Missing code or state parameter",
      isDirectGitHubInstall: false,
    };
  }

  if (!storedState || storedState !== state) {
    return {
      valid: false,
      error: "Invalid state parameter",
      isDirectGitHubInstall: false,
    };
  }

  return {
    valid: true,
    isDirectGitHubInstall: false,
  };
}

/**
 * Verifies that an installation ID belongs to the authenticated user.
 * Returns the verified installation ID, or undefined if not found/mismatch.
 */
export function verifyInstallationId(
  claimedInstallationId: string | null,
  userInstallations: Array<{ id: number | string; app_id: number | string }>,
  appId: string,
): { verified: boolean; installationId?: string; error?: string } {
  if (claimedInstallationId) {
    // Verify the claimed installation belongs to this user AND is for our app.
    // A user may have multiple installations of the same app (personal + org accounts),
    // so we must match on both id and app_id — not just app_id.
    const installation = userInstallations.find(
      (inst) => String(inst.id) === claimedInstallationId && String(inst.app_id) === appId,
    );
    if (!installation) {
      return {
        verified: false,
        error: `Installation ID ${claimedInstallationId} does not belong to authenticated user`,
      };
    }
    return { verified: true, installationId: claimedInstallationId };
  }

  // No claimed installation_id — look up any existing installation for our app
  const installation = userInstallations.find((inst) => String(inst.app_id) === appId);
  if (!installation) {
    return { verified: true, installationId: undefined }; // No installation yet, that's OK
  }
  return { verified: true, installationId: String(installation.id) };
}
