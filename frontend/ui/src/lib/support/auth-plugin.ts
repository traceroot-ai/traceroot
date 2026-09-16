import { randomBytes, randomUUID } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie, expireCookie, setSessionCookie } from "better-auth/cookies";
import { prisma } from "@traceroot/core";
import { z } from "zod";
import { isStaff } from "./policy";
import { SESSION_EXPIRES_IN_SECONDS } from "@/lib/session-config";

export const supportPlugin = () =>
  ({
    id: "support-console",
    endpoints: {
      supportStart: createAuthEndpoint(
        "/support/start",
        {
          method: "POST",
          requireHeaders: true,
          body: z.object({
            userId: z.string().min(1),
            reason: z.string().trim().max(500).optional().default(""),
          }),
        },
        async (ctx) => {
          const current = await getSessionFromCtx(ctx);
          if (!current || current.session.impersonatedBy)
            throw new APIError("FORBIDDEN", {
              message: "Use your employee session to start impersonation",
            });
          const id = randomUUID();
          const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_SECONDS * 1000);
          const result = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM users WHERE id IN (${current.user.id}, ${ctx.body.userId}) ORDER BY id FOR UPDATE`;
            const actor = await tx.user.findUnique({ where: { id: current.user.id } });
            const target = await tx.user.findUnique({ where: { id: ctx.body.userId } });
            if (!actor || !isStaff(actor.role) || actor.banned)
              throw new APIError("FORBIDDEN", { message: "Staff access required" });
            if (!target || isStaff(target.role) || target.banned || target.id === actor.id) {
              await tx.auditLog.create({
                data: {
                  actorUserId: actor.id,
                  actorEmail: actor.email,
                  targetUserId: ctx.body.userId,
                  targetEmail: target?.email,
                  operation: "impersonation.denied",
                  resourceType: "user",
                  resourceId: ctx.body.userId,
                  transport: "admin",
                  outcome: "denied",
                  summary: { reason: ctx.body.reason || null },
                },
              });
              return null;
            }
            const session = await tx.session.create({
              data: {
                id,
                token: randomBytes(32).toString("hex"),
                userId: target.id,
                impersonatedBy: actor.id,
                expiresAt,
              },
            });
            await tx.auditLog.create({
              data: {
                actorUserId: actor.id,
                actorEmail: actor.email,
                targetUserId: target.id,
                targetEmail: target.email,
                impersonationSessionId: id,
                operation: "impersonation.started",
                resourceType: "session",
                resourceId: id,
                transport: "admin",
                outcome: "success",
                expiresAt,
                summary: {
                  reason: ctx.body.reason || null,
                  mode: actor.role === "admin" ? "read-write" : "read-only",
                },
              },
            });
            return { session, user: { ...target, name: target.name ?? target.email } };
          });
          if (!result)
            throw new APIError("FORBIDDEN", {
              message: "Staff or unavailable accounts cannot be impersonated",
            });
          const original = ctx.context.createAuthCookie("support_original", {
            maxAge: SESSION_EXPIRES_IN_SECONDS,
          });
          await ctx.setSignedCookie(
            original.name,
            `${current.session.token}:${id}`,
            ctx.context.secret,
            original.attributes,
          );
          await setSessionCookie(ctx, result, false);
          return ctx.json({ success: true, expiresAt });
        },
      ),
      supportStop: createAuthEndpoint(
        "/support/stop",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          const cookie = ctx.context.createAuthCookie("support_original");
          const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          const current = !value ? await getSessionFromCtx(ctx) : null;
          if (!value && !current?.session.impersonatedBy) {
            // Nothing to unwind. A genuine login (e.g. the employee session
            // already restored by another tab) must be left signed in.
            expireCookie(ctx, cookie);
            return ctx.json({ restored: !!current });
          }
          // A lost restore cookie must not leave a copied customer token live.
          const [token, id] = value ? value.split(":") : ["", current!.session.id];
          const original = token
            ? await prisma.session.findUnique({
                where: { token },
                include: { user: true },
              })
            : null;
          const started = await prisma.auditLog.findFirst({
            where: { impersonationSessionId: id, operation: "impersonation.started" },
          });
          await prisma.$transaction(async (tx) => {
            const live = await tx.session.findUnique({
              where: { id },
              select: { expiresAt: true },
            });
            await tx.session.deleteMany({ where: { id } });
            if (started && !started.endedAt) {
              const expiresAt = live?.expiresAt ?? started.expiresAt;
              const expired = expiresAt && expiresAt.getTime() <= Date.now();
              await tx.auditLog.updateMany({
                where: { id: started.id, endedAt: null },
                data: {
                  expiresAt,
                  endedAt: expired ? expiresAt : new Date(),
                  endReason: expired ? "expired" : "exit",
                },
              });
            }
          });
          deleteSessionCookie(ctx);
          expireCookie(ctx, cookie);
          const restored =
            !!original &&
            original.expiresAt.getTime() > Date.now() &&
            !original.user.banned &&
            !original.impersonatedBy;
          if (restored)
            await setSessionCookie(ctx, {
              session: original,
              user: { ...original.user, name: original.user.name ?? original.user.email },
            });
          return ctx.json({ restored });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
