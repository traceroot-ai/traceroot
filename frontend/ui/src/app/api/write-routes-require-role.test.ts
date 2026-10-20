/**
 * Guard: every handler that writes, under the user-session route trees below,
 * passes a minimum role (MEMBER or ADMIN). Without one, a VIEWER passes the
 * membership check and can write — the demo workspace makes every user a
 * viewer, so this must not regress.
 *
 * The check follows each exported POST/PUT/PATCH/DELETE to its handler body
 * (in the route file or the module it imports from), then parses authorization
 * calls for a role argument. A handler that is meant to be open to viewers goes in
 * ALLOWED with the reason.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC = path.resolve(__dirname, "../..");
const API = path.join(SRC, "app/api");
const TREES = ["projects", "workspaces", "github"];
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

const ALLOWED: Record<string, string> = {
  "POST /api/projects/[projectId]/ai/sessions":
    "Starts the caller's own chat. Viewers may chat; demoAgentWriteDenied blocks demo viewers.",
  "DELETE /api/projects/[projectId]/ai/sessions/[sessionId]":
    "Deletes only the caller's own session; the agent service checks the owner.",
  "POST /api/projects/[projectId]/ai/sessions/[sessionId]/decisions":
    "Approves the agent's pending write; the write runs as the caller and the write service requires MEMBER.",
  "POST /api/projects/[projectId]/ai/sessions/[sessionId]/messages":
    "Sends a message in the caller's own chat. Viewers may chat; demoAgentWriteDenied blocks demo viewers.",
  "POST /api/workspaces": "Any signed-in user may create their own workspace.",
  "POST /api/github/callback": "OAuth callback; the install flow checks the role before it starts.",
};

// Reads that hand out a credential with write power. They need a role floor
// like a write does.
const CREDENTIAL_READS = ["GET /api/github/token"];

// Calls that carry a role floor, e.g. requireProjectAccess(id, pid, Role.MEMBER),
// requireProjectAuth(params, Role.MEMBER), authorize(projectId, Role.MEMBER),
// requireWorkspaceMembership(uid, wid, "ADMIN").
function hasRoleCheck(source: string): boolean {
  const file = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      /^(require\w*|authorize|access)$/.test(node.expression.getText(file))
    ) {
      found ||= node.arguments.some((argument) => {
        let arg = argument;
        while (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg)) arg = arg.expression;
        return (
          (ts.isPropertyAccessExpression(arg) &&
            arg.expression.getText(file) === "Role" &&
            /^(MEMBER|ADMIN)$/.test(arg.name.text)) ||
          (ts.isStringLiteral(arg) && /^(MEMBER|ADMIN)$/.test(arg.text))
        );
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name === "route.ts" ? [p] : [];
  });
}

function bodyOf(src: string, name: string): string | null {
  const start = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]|(?:export\\s+)?const\\s+${name}\\s*=`,
  ).exec(src);
  if (!start) return null;
  const rest = src.slice(start.index + start[0].length);
  const next = /\n(?:export\s+)?(?:async\s+)?function\s+\w+|\nexport\s+const\s+\w+/.exec(rest);
  return src.slice(start.index, start.index + start[0].length + (next ? next.index : rest.length));
}

function importedFile(routeFile: string, src: string, name: string): [string, string] | null {
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const part of m[1].split(",")) {
      const [orig, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      if ((alias ?? orig) !== name) continue;
      const spec = m[2];
      const base = spec.startsWith("@/")
        ? path.join(SRC, spec.slice(2))
        : spec.startsWith(".")
          ? path.resolve(path.dirname(routeFile), spec)
          : null;
      if (!base) return null;
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (fs.existsSync(base + ext)) return [base + ext, orig];
      }
      return null;
    }
  }
  return null;
}

function handlerBody(routeFile: string, src: string, method: string): string | null {
  const exported = new RegExp(`export\\s+const\\s+${method}\\s*=\\s*([^;\\n]+)`).exec(src);
  if (!exported) {
    return new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(src)
      ? bodyOf(src, method)
      : null;
  }
  const names = exported[1].match(/\b\w+\b/g) ?? [];
  const handler = names.filter((n) => n !== "withImpersonationPolicy").pop();
  if (!handler) return null;
  const local = bodyOf(src, handler);
  if (local) return local;
  const imported = importedFile(routeFile, src, handler);
  return imported ? bodyOf(fs.readFileSync(imported[0], "utf8"), imported[1]) : null;
}

function handlerFor(key: string): string | null {
  const [method, route] = key.split(" ");
  const file = path.join(API, route.replace(/^\/api\//, ""), "route.ts");
  return handlerBody(file, fs.readFileSync(file, "utf8"), method);
}

const writeHandlers = TREES.flatMap((tree) => walk(path.join(API, tree))).flatMap((file) => {
  const src = fs.readFileSync(file, "utf8");
  const route = "/api/" + path.relative(API, path.dirname(file)).split(path.sep).join("/");
  return WRITE_METHODS.filter((m) =>
    new RegExp(`export\\s+(?:const|(?:async\\s+)?function)\\s+${m}\\b`).test(src),
  ).map((method) => ({ key: `${method} ${route}`, body: handlerBody(file, src, method) }));
});

describe("write routes require a minimum role", () => {
  it("requires an authorization call, not comments or incidental role strings", () => {
    expect(hasRoleCheck('// requireAccess(id, Role.ADMIN)\nthrow Error("ADMIN");')).toBe(false);
    expect(hasRoleCheck('const role = Role.MEMBER; log("ADMIN");')).toBe(false);
    expect(hasRoleCheck("await requireProjectAccess(uid, pid, Role.MEMBER);")).toBe(true);
    expect(hasRoleCheck('await requireWorkspaceMembership(uid, wid, "ADMIN");')).toBe(true);
  });
  it("finds the write handlers it guards", () => {
    expect(writeHandlers.length).toBeGreaterThan(30);
    expect(writeHandlers.every((h) => h.body !== null)).toBe(true);
  });

  it("every write handler passes MEMBER or ADMIN, or is allowed with a reason", () => {
    const missing = writeHandlers
      .filter((h) => !(h.key in ALLOWED) && !hasRoleCheck(h.body ?? ""))
      .map((h) => h.key);
    expect(missing).toEqual([]);
  });

  it("reads that hand out a write credential also pass MEMBER or ADMIN", () => {
    const missing = CREDENTIAL_READS.filter((key) => !hasRoleCheck(handlerFor(key) ?? ""));
    expect(missing).toEqual([]);
  });

  it("every allowed entry still exists, so the list cannot go stale", () => {
    const keys = new Set(writeHandlers.map((h) => h.key));
    expect(Object.keys(ALLOWED).filter((k) => !keys.has(k))).toEqual([]);
  });
});
