/**
 * Whether the welcome email says a Slack invite is coming.
 *
 * The invites are sent by the lead service, behind its own switch, which the
 * web app cannot see. WELCOME_SLACK_INVITE_LINE_ENABLED is the web app's copy
 * of it: turn the two on and off together, so the email never promises an
 * invite that is not being sent.
 *
 * Of the lead service's rules, only the address ones are repeated here: a
 * personal mailbox or a school gets no invite. It also skips team and test
 * accounts; those few seeing the sentence anyway does no harm.
 */
import { isPersonalEmail } from "@/lib/personal-email";

/** `.edu`, `.edu.<country>` and `.ac.<country>`, as the lead service's invite job checks. */
const SCHOOL_DOMAIN = /(?:^|\.)(?:edu|edu\.[a-z]{2}|ac\.[a-z]{2})$/;

export function isSchoolEmail(email: string): boolean {
  const domain = email
    .slice(email.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase();
  return SCHOOL_DOMAIN.test(domain);
}

export function slackInviteLineFor(
  email: string,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (environment.WELCOME_SLACK_INVITE_LINE_ENABLED?.trim().toLowerCase() !== "true") return false;
  return !isPersonalEmail(email) && !isSchoolEmail(email);
}
