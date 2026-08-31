// Unambiguous alphabet (no 0/O/1/I) so a user reading the code aloud, or typing
// it from a screen at a glance, can't confuse similar-looking characters.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Raw 8-character user code, no separators. This is what gets stored and what
// the plugin's lookup routes compare against — better-auth's device-verify,
// device-approve, and device-deny endpoints all strip hyphens from the
// incoming code before querying (`user_code.replace(/-/g, "")`), so the
// stored value must be hyphen-free or every lookup mismatches and fails with
// INVALID_USER_CODE. Hyphens are added only at display time, via
// formatUserCode below.
export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
}

// Formats a raw 8-character code as "XXXX-XXXX" for display (the /device
// page, CLI output). Not used for storage or lookup — see generateUserCode.
export function formatUserCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
