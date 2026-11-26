/**
 * Whether an address is a personal mailbox rather than a work one, and the
 * company domain a typed answer names.
 *
 * The list is the one the lead service filters sign-ups with
 * (`PERSONAL_DOMAINS` in its `src/leads/filter.ts`): the two have to agree, or
 * someone the web app asks for their company is someone the lead service
 * already took a company from, or the other way round. Change both together;
 * personal-email.test.ts holds the sample addresses both sides test.
 */
export const PERSONAL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "ymail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "mail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "foxmail.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "duck.com",
  "tutanota.com",
  "naver.com",
]);

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return (
    email
      .slice(at + 1)
      .trim()
      .toLowerCase() || null
  );
}

/** A personal mailbox, by its domain. An address with no domain counts as one. */
export function isPersonalEmail(email: string | null | undefined): boolean {
  const domain = email ? domainOf(email) : null;
  return !domain || PERSONAL_DOMAINS.has(domain);
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The domain in an answer to "Which company or project is this for?": a
 * website (`acme.com`, `https://www.acme.com/about`) or an address
 * (`kai@acme.com`). An answer that is only a name (`Acme`) has none; it is kept
 * as typed, but nothing can be looked up from it.
 */
export function companyDomainFrom(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (!text) return null;
  if (text.includes("@") && !text.includes("/")) text = domainOf(text) ?? "";
  text = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return HOSTNAME.test(text) ? text : null;
}
