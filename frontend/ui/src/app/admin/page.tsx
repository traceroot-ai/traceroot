import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@traceroot/core";
import { isStaff } from "@/lib/support/policy";
import { impersonationContext } from "@/lib/support/session";
import { SupportConsole } from "@/features/support/support-console";
import { ReturnToConsole } from "@/features/support/return-to-console";
import { hasSupportRestoreCookie } from "@/lib/support/restoration";

export default async function AdminPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session && hasSupportRestoreCookie(requestHeaders)) return <ReturnToConsole ended />;
  if (session?.session.impersonatedBy) {
    // Even an ended session gets the exit page: the only way back to the
    // employee account is the stop endpoint, which must stay reachable.
    const context = await impersonationContext(session.session);
    return <ReturnToConsole ended={!context?.valid} />;
  }
  const actor = session ? await prisma.user.findUnique({ where: { id: session.user.id } }) : null;
  if (!actor || !isStaff(actor.role) || actor.banned) notFound();
  return <SupportConsole role={actor.role as "support" | "admin"} actorId={actor.id} />;
}
