import type { FollowUp } from "@/lib/lifecycle/follow-up";
import { renderFounderEmail } from "../founder-email";
import { followUpCopy, type FollowUpLinks } from "./copy";

export interface RenderFollowUpInput {
  campaign: FollowUp;
  firstName: string | null;
  links: FollowUpLinks;
  unsubscribeUrl: string;
}

/** One follow-up email, in the founder-signed layout (../founder-email.ts). */
export function renderFollowUp(input: RenderFollowUpInput): {
  subject: string;
  text: string;
  html: string;
} {
  return renderFounderEmail(followUpCopy(input.campaign, input.links), input);
}
