import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { impersonationContext } from "@/lib/support/session";
import { NextRequest } from "next/server";
import { hasSupportRestoreCookie } from "@/lib/support/restoration";

const handlers = toNextJsHandler(auth);

// Rebuild the request's Cookie header after applying a Set-Cookie list, so a
// follow-up call in the same request sees the cookies the browser will hold.
function applySetCookies(cookieHeader: string | null, setCookies: string[]) {
  const jar = new Map<string, string>();
  for (const pair of (cookieHeader ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  for (const entry of setCookies) {
    const [pair, ...attributes] = entry.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const deleted = attributes.some((attribute) => /^\s*max-age=0$/i.test(attribute)) || !value;
    if (deleted) jar.delete(name);
    else jar.set(name, value);
  }
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join("; ");
}

// An impersonation that ended server-side (staff revoked, customer banned,
// session closed) must clean itself up on the next session read. Otherwise the
// browser keeps the dead customer cookie, every page bounces to sign-in, and
// sign-in itself is blocked — with no exit control on that page.
async function endImpersonation(request: NextRequest, path: string) {
  const stopped = await auth.api.supportStop({ headers: request.headers, asResponse: true });
  if (!stopped.ok) return stopped;
  const setCookies = stopped.headers.getSetCookie();
  if (path !== "/get-session") {
    const response = Response.json(
      { error: "Support session ended. Reload to continue on your own account." },
      { status: 403 },
    );
    for (const cookie of setCookies) response.headers.append("set-cookie", cookie);
    return response;
  }
  const headers = new Headers(request.headers);
  headers.set("cookie", applySetCookies(request.headers.get("cookie"), setCookies));
  const restored = await handlers.GET(new NextRequest(request.url, { headers }));
  const response = new Response(restored.body, restored);
  for (const cookie of setCookies) response.headers.append("set-cookie", cookie);
  return response;
}

async function handle(request: NextRequest) {
  const path = new URL(request.url).pathname.replace("/api/auth", "");
  // Preserve old clients' exit URL, but use the audited stop/recovery flow.
  if (path === "/admin/stop-impersonating" && request.method === "POST")
    return auth.api.supportStop({ headers: request.headers, asResponse: true });
  // The console owns grants and audited starts. Never leave the built-in admin
  // endpoints as an alternate, unaudited privilege-management surface.
  if (path.startsWith("/admin/"))
    return Response.json({ error: "Use the support console" }, { status: 403 });
  if (path !== "/support/stop") {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session && path === "/get-session" && hasSupportRestoreCookie(request.headers))
      return endImpersonation(request, path);
    if (session?.session.impersonatedBy) {
      const context = await impersonationContext(session.session);
      if (!context?.valid) return endImpersonation(request, path);
      if (path !== "/get-session")
        return Response.json(
          { error: "Exit impersonation before managing authentication" },
          { status: 403 },
        );
    }
  }
  return request.method === "GET" ? handlers.GET(request) : handlers.POST(request);
}
export const GET = handle;
export const POST = handle;
