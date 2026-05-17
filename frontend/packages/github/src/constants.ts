// Cookie names (prefixed with x- for header passthrough)
export const GITHUB_ACCESS_TOKEN_COOKIE = "x-github-access-token";
export const GITHUB_INSTALLATION_ID_COOKIE = "x-github-installation-id";
export const GITHUB_AUTH_STATE_COOKIE = "github_auth_state";
export const GITHUB_INSTALL_STATE_COOKIE = "github_install_state";
export const GITHUB_RETURN_TO_COOKIE = "github_return_to";
// Workspace the user is connecting GitHub to. Captured at /api/github/login or
// /api/github/install kickoff and read by the install-callback to attach the
// resulting installation to the right workspace.
export const GITHUB_WORKSPACE_ID_COOKIE = "github_workspace_id";
