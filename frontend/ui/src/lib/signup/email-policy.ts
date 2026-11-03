// Which email domains may open an account. Pure and dependency-free so the
// server hook (lib/auth.ts) and the sign-up form share one definition. Format
// is not checked here: better-auth and the form schema already do that, and
// this only looks at the part after the last "@".
import { DISPOSABLE_DOMAINS } from "./disposable-domains";

export type EmailPolicyRejection = "reserved" | "disposable";

export type EmailPolicyResult = { ok: true } | { ok: false; reason: EmailPolicyRejection };

// Reserved for documentation, testing or local use and never deliverable on the
// public internet: RFC 2606 (test, example, invalid, localhost and the
// example.com/net/org second-level names), RFC 6761, RFC 6762 (local),
// RFC 7686 (onion), RFC 8375 (home.arpa) and ICANN's private-use "internal".
const RESERVED_TLDS = new Set([
  "test",
  "example",
  "invalid",
  "localhost",
  "local",
  "onion",
  "internal",
]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org", "home.arpa"]);

export const EMAIL_POLICY_MESSAGES: Record<EmailPolicyRejection, string> = {
  reserved: "This email domain can't receive mail. Please use a real email address.",
  disposable: "Disposable email addresses aren't supported. Please use a permanent address.",
};

/** The domain with a trailing root dot removed, or "" when there is none. */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1) return "";
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

/** True when `domain` is one of `set` or a subdomain of one. */
function matchesSuffix(domain: string, set: ReadonlySet<string>): boolean {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (set.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

export function checkSignupEmail(email: string): EmailPolicyResult {
  const domain = emailDomain(email);
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  // A dotless or IP-literal domain is never a public mailbox.
  if (!domain.includes(".") || domain.startsWith("[") || RESERVED_TLDS.has(tld)) {
    return { ok: false, reason: "reserved" };
  }
  if (matchesSuffix(domain, RESERVED_DOMAINS)) return { ok: false, reason: "reserved" };
  if (matchesSuffix(domain, DISPOSABLE_DOMAINS)) return { ok: false, reason: "disposable" };
  return { ok: true };
}
