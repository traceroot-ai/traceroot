// Human-readable names for the consent page, keyed by client id.
export const DEVICE_CLIENT_NAMES: Record<string, string> = {
  "traceroot-cli": "TraceRoot CLI",
};

// client_id is display metadata for the consent screen, NOT a security boundary:
// the device flow's security comes from the user approving a code in an authenticated
// session, not from the client id. The allowlist just limits which ids may start a flow.
// Derived from DEVICE_CLIENT_NAMES so the two constants cannot drift apart.
export const DEVICE_CLIENT_IDS = new Set<string>(Object.keys(DEVICE_CLIENT_NAMES));
