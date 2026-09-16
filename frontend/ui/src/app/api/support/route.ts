import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { auth } from "@/lib/auth";
import { isStaff } from "@/lib/support/policy";
import { impersonationContext } from "@/lib/support/session";
import { z } from "zod";

async function employee(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || session.session.impersonatedBy) return null;
  const actor = await prisma.user.findUnique({ where: { id: session.user.id } });
  return actor && isStaff(actor.role) && !actor.banned ? actor : null;
}
const missing = () => Response.json({ error: "Not found" }, { status: 404 });
const querySchema = z.object({
  view: z.enum(["users", "staff", "context"]).default("users"),
  q: z.string().max(320).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  projectId: z.string().max(200).optional(),
  workspaceId: z.string().max(200).optional(),
});

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return Response.json({ error: "Invalid filters" }, { status: 400 });
  const { view, q, page } = parsed.data;
  if (view === "context") {
    const session = await auth.api.getSession({ headers: request.headers });
    const context = session?.session.impersonatedBy
      ? await impersonationContext(session.session)
      : null;
    let workspace: { name: string; id: string } | null = null;
    if (context?.valid && session) {
      const workspaceId =
        parsed.data.workspaceId ??
        (parsed.data.projectId
          ? (
              await prisma.project.findUnique({
                where: { id: parsed.data.projectId },
                select: { workspaceId: true },
              })
            )?.workspaceId
          : undefined);
      if (workspaceId)
        workspace =
          (
            await prisma.workspaceMember.findUnique({
              where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
              select: { workspace: { select: { id: true, name: true } } },
            })
          )?.workspace ?? null;
    }
    return Response.json(
      context
        ? {
            impersonating: true,
            valid: context.valid,
            targetEmail: context.target?.email,
            mode: context.actor?.role === "admin" ? "read-write" : "read-only",
            expiresAt: context.expiresAt,
            reason: (context.start?.summary as { reason?: string | null } | null)?.reason ?? null,
            workspace,
          }
        : { impersonating: false },
    );
  }
  const actor = await employee(request);
  if (!actor) return missing();
  if (view === "staff") {
    if (actor.role !== "admin") return missing();
    return Response.json({
      rows: await prisma.user.findMany({
        where: { email: { endsWith: "@traceroot.ai", mode: "insensitive" } },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          emailVerified: true,
          banned: true,
        },
        orderBy: { email: "asc" },
      }),
    });
  }
  const where = q
    ? { OR: [{ id: q }, { email: { contains: q, mode: "insensitive" as const } }] }
    : {};
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        banned: true,
      },
      orderBy: [{ email: "asc" }, { id: "asc" }],
      skip: (page - 1) * 25,
      take: 25,
    }),
    prisma.user.count({ where }),
  ]);
  return Response.json({ rows, total });
}

const grantSchema = z.object({ email: z.email(), role: z.enum(["support", "admin"]).nullable() });
export async function POST(request: NextRequest) {
  const actor = await employee(request);
  if (!actor || actor.role !== "admin") return missing();
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  const parsed = grantSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Valid email and role required" }, { status: 400 });
  const { email, role } = parsed.data;
  const result = await prisma.$transaction(async (tx) => {
    let found = await tx.user.findUnique({ where: { email } });
    if (!found) {
      const matches = await tx.user.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        orderBy: { id: "asc" },
        take: 2,
      });
      if (matches.length > 1) return "Email matches more than one account";
      found = matches[0];
    }
    if (!found) return "Choose an existing account";
    await tx.$queryRaw`SELECT id FROM users WHERE id IN (${actor.id}, ${found.id}) ORDER BY id FOR UPDATE`;
    const [current, target] = await Promise.all([
      tx.user.findUniqueOrThrow({ where: { id: actor.id } }),
      tx.user.findUniqueOrThrow({ where: { id: found.id } }),
    ]);
    if (current.role !== "admin" || current.banned) return "Admin access required";
    if (current.id === target.id) return "You cannot change your own role";
    if (
      role &&
      (!target.emailVerified ||
        !target.email.toLowerCase().endsWith("@traceroot.ai") ||
        target.banned)
    )
      return "Choose a verified @traceroot.ai employee account";
    if (target.role === role) return null;
    await tx.user.update({ where: { id: target.id }, data: { role } });
    await tx.auditLog.create({
      data: {
        actorUserId: current.id,
        actorEmail: current.email,
        targetUserId: target.id,
        targetEmail: target.email,
        operation: role ? "staff.granted" : "staff.revoked",
        resourceType: "user",
        resourceId: target.id,
        transport: "admin",
        outcome: "success",
        summary: { previousRole: target.role, role },
      },
    });
    if (!role) {
      await tx.auditLog.updateMany({
        where: {
          actorUserId: target.id,
          operation: "impersonation.started",
          endedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { endedAt: new Date(), endReason: "revoked" },
      });
    }
    return null;
  });
  return result
    ? Response.json({ error: result }, { status: 400 })
    : Response.json({ success: true });
}
