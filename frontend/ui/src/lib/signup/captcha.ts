// Optional CAPTCHA (Cloudflare Turnstile) on email sign-up. Off unless both
// keys are set: a secret without a site key would reject every signup (the
// form could never produce a token), and a site key without a secret would
// render a widget nothing checks. Dependency-free so proxy.ts can read it for
// the CSP without pulling in better-auth.

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export interface TurnstileKeys {
  siteKey: string;
  secretKey: string;
}

export function turnstileKeys(env: Record<string, string | undefined>): TurnstileKeys | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  return siteKey && secretKey ? { siteKey, secretKey } : null;
}
