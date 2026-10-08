// Unsubscribe links and headers for product email. The token is an HMAC over the address,
// so it can do exactly one thing (opt out that address) and nobody can forge one for
// someone else. The key derives from TRACEROOT_EMAIL_TOKEN_SECRET (comma-separated for
// rotation: the first signs, all verify), falling back to BETTER_AUTH_SECRET.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const HKDF_INFO = "traceroot-email-unsubscribe";
const KEY_LENGTH = 32;

export const ONE_CLICK_UNSUBSCRIBE_BODY = "List-Unsubscribe=One-Click";

export const UNSUBSCRIBE_PATH = "/api/email/unsubscribe";

export function unsubscribeSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.TRACEROOT_EMAIL_TOKEN_SECRET?.trim() || env.BETTER_AUTH_SECRET?.trim() || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", HKDF_INFO, KEY_LENGTH));
}

function mac(email: string, secret: string): Buffer {
  return createHmac("sha256", deriveKey(secret)).update(email).digest();
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** `base64url(email).base64url(hmac)`. No expiry on purpose: anti-spam law wants opt-out to work 30+ days. */
export function signUnsubscribeToken(
  email: string,
  secrets: string[] = unsubscribeSecrets(),
): string {
  const signing = secrets[0];
  if (!signing) {
    throw new Error(
      "No unsubscribe signing secret: set TRACEROOT_EMAIL_TOKEN_SECRET or BETTER_AUTH_SECRET",
    );
  }
  const normalized = normalizeEmail(email);
  return `${b64url(Buffer.from(normalized, "utf8"))}.${b64url(mac(normalized, signing))}`;
}

export type UnsubscribeTokenCheck = { valid: true; email: string } | { valid: false };

/** Never throws: anything malformed is simply invalid. */
export function verifyUnsubscribeToken(
  token: string,
  secrets: string[] = unsubscribeSecrets(),
): UnsubscribeTokenCheck {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false };
  let email: string;
  let provided: Buffer;
  try {
    email = Buffer.from(parts[0], "base64url").toString("utf8");
    provided = Buffer.from(parts[1], "base64url");
  } catch {
    return { valid: false };
  }
  if (!email || email !== normalizeEmail(email) || provided.length === 0) return { valid: false };

  // Constant-time compare on hashes of both sides, so a length mismatch cannot throw or leak.
  const providedHash = createHash("sha256").update(provided).digest();
  for (const secret of secrets) {
    const expectedHash = createHash("sha256").update(mac(email, secret)).digest();
    if (timingSafeEqual(providedHash, expectedHash)) return { valid: true, email };
  }
  return { valid: false };
}

/** RFC 8058 pair. `url` must be https and accept a POST of ONE_CLICK_UNSUBSCRIBE_BODY. */
export function unsubscribeHeaders(params: {
  url: string;
  mailto: string;
}): Record<string, string> {
  return {
    // The mailto stays alongside because some clients only act on mailto.
    "List-Unsubscribe": `<mailto:${params.mailto}?subject=unsubscribe>, <${params.url}>`,
    "List-Unsubscribe-Post": ONE_CLICK_UNSUBSCRIBE_BODY,
  };
}
