// Reserved names for documentation, testing, and private use (RFC 2606,
// RFC 6761, RFC 6762, RFC 7686, RFC 8375, and ICANN's .internal).
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

// Common disposable inbox domains, from the CC0 list at
// https://github.com/disposable-email-domains/disposable-email-domains.
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "anonbox.net",
  "byom.de",
  "discard.email",
  "discardmail.com",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "emailfake.com",
  "fakeinbox.com",
  "fakemail.net",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxbear.com",
  "incognitomail.org",
  "jetable.org",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailinator2.com",
  "mailnesia.com",
  "mailpoof.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "mytrashmail.com",
  "nada.email",
  "sharklasers.com",
  "spam4.me",
  "spambox.us",
  "temp-mail.org",
  "tempail.com",
  "tempinbox.com",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "tmail.ws",
  "tmpmail.net",
  "tmpmail.org",
  "trash-mail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

const RESERVED = {
  code: "EMAIL_DOMAIN_RESERVED",
  message: "This email domain can't receive mail. Please use a real email address.",
};
const DISPOSABLE = {
  code: "EMAIL_DOMAIN_DISPOSABLE",
  message: "Disposable email addresses aren't supported. Please use a permanent address.",
};

function matchesDomain(domain: string, domains: ReadonlySet<string>): boolean {
  const labels = domain.split(".");
  return labels.some((_, index) => domains.has(labels.slice(index).join(".")));
}

export function isSignupEmailPolicyEnabled(authURL: string): boolean {
  return URL.parse(authURL)?.origin === "https://app.traceroot.ai";
}

// Email format is validated separately by Better Auth and the sign-up form.
export function signupEmailError(email: string) {
  const at = email.lastIndexOf("@");
  if (at === -1) return RESERVED;

  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const lastDot = domain.lastIndexOf(".");
  if (
    lastDot === -1 ||
    domain.startsWith("[") ||
    RESERVED_TLDS.has(domain.slice(lastDot + 1)) ||
    matchesDomain(domain, RESERVED_DOMAINS)
  ) {
    return RESERVED;
  }
  return matchesDomain(domain, DISPOSABLE_DOMAINS) ? DISPOSABLE : undefined;
}
