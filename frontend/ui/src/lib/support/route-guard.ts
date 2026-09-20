import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@traceroot/core";
import { impersonationContext } from "./session";
import { DENIED_HEADER, impersonationDenial, isRead } from "./policy";
import { supportRequest } from "./request-context";
import { guardSupportStream } from "./stream";

// Every cookie-authenticated API handler is wrapped here; tests enforce coverage.
// Existing membership checks still run as the customer, never as the employee.
export function withImpersonationPolicy<R extends Response>(
  handler: (request: NextRequest) => Promise<R>,
): (request: NextRequest) => Promise<R | NextResponse>;
export function withImpersonationPolicy<C, R extends Response>(
  handler: (request: NextRequest, context: C) => Promise<R>,
): (request: NextRequest, context: C) => Promise<R | NextResponse>;
export function withImpersonationPolicy<C, R extends Response>(
  handler: (request: NextRequest, context: C) => Promise<R>,
) {
  return async (request: NextRequest, context?: C): Promise<R | NextResponse> => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.session.impersonatedBy)
      return supportRequest.run({ session, impersonation: null }, () =>
        handler(request, context as C),
      );
    const support = await impersonationContext(session.session);
    if (!support?.valid)
      return NextResponse.json(
        { error: "Impersonation ended. Exit to return to your account." },
        { status: 403, headers: { [DENIED_HEADER]: "ended" } },
      );
    const url = new URL(request.url);
    const denial = impersonationDenial(url.pathname, request.method, support.actor?.role);
    if (denial)
      return NextResponse.json(
        { error: denial },
        { status: 403, headers: { [DENIED_HEADER]: "policy" } },
      );
    const authorized = async () => {
      const live = await auth.api.getSession({ headers: request.headers });
      if (!live || live.session.id !== session.session.id || !live.session.impersonatedBy)
        return false;
      const context = await impersonationContext(live.session);
      return (
        !!context?.valid && !impersonationDenial(url.pathname, request.method, context.actor?.role)
      );
    };
    const streaming = (response: Response) =>
      response.body && response.headers.get("content-type")?.includes("text/event-stream");
    if (isRead(request.method)) {
      const response = await supportRequest.run({ session, impersonation: support }, () =>
        handler(request, context as C),
      );
      return streaming(response)
        ? guardSupportStream(response, request.signal, authorized)
        : response;
    }
    // Persist intent BEFORE side effects; a disconnected/failed response remains
    // 'pending', never falsely described as a rollback or retried automatically.
    const projectId = url.pathname.match(/\/projects\/([^/]+)/)?.[1];
    const workspaceId =
      url.pathname.match(/\/workspaces\/([^/]+)/)?.[1] ??
      (projectId
        ? (
            await prisma.project.findUnique({
              where: { id: projectId },
              select: { workspaceId: true },
            })
          )?.workspaceId
        : undefined);
    const event = await prisma.auditLog.create({
      data: {
        actorUserId: support.actor!.id,
        actorEmail: support.actor!.email,
        targetUserId: session.user.id,
        targetEmail: session.user.email,
        impersonationSessionId: session.session.id,
        operation: "impersonation.write",
        resourceType: "api",
        resourceId: url.pathname,
        workspaceId,
        projectId,
        transport: "admin",
        outcome: "pending",
        summary: { method: request.method, path: url.pathname },
      },
    });
    let response: R;
    try {
      response = await supportRequest.run({ session, impersonation: support }, () =>
        handler(request, context as C),
      );
    } catch (error) {
      await prisma.auditLog
        .update({ where: { id: event.id }, data: { outcome: "unknown" } })
        .catch(() => {});
      throw error;
    }
    // Preserve the actual response if finalization fails: the durable intent is
    // retained for reconciliation, and clients must not retry a committed action.
    const finalize = async (outcome: string) => {
      await prisma.auditLog
        .update({
          where: { id: event.id },
          data: {
            outcome,
            summary: { method: request.method, path: url.pathname, status: response.status },
          },
        })
        .catch(() => {
          console.error("Support audit outcome pending", event.id);
        });
    };
    if (response.ok && streaming(response))
      return guardSupportStream(response, request.signal, authorized, finalize);
    await finalize(response.ok ? "success" : "error");
    return response;
  };
}
