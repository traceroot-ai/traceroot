// The surfaces that render on their own, with no app shell around them: no
// workspace rail, no header bar, no AI panel — just the page, centred on an
// otherwise empty background. AppLayout is the only consumer; this module
// exists so the set is one explicit list with the reason for each entry next to
// it, rather than a condition buried in a component.
//
// The reasons differ per route, and none of them generalises into a rule:
//
// - `/auth/*` and `/device` are reachable while SIGNED OUT. Wrapping them in
//   the authenticated shell renders a bogus "User" menu and a workspace rail
//   around an account that may not even exist yet.
//
// - `/onboarding` is signed-in only, so that reason does not apply to it. Its
//   reason is that the shell offers ways out of a flow that has exactly one way
//   forward: the account reaching this page has no project yet — it may already
//   own a workspace to add one to, which is what `?workspaceId=` project-only
//   mode is for — so every rail entry is empty or a dead end. The shell is also
//   load-bearing
//   rather than cosmetic here, because the page carries a `?callbackUrl=` that
//   a waiting `traceroot setup` terminal is polling against — one stray rail
//   click drops the query, and the CLI then polls for the whole device-code
//   lifetime with nothing left to point the user back at the handoff.
const CHROMELESS_ROUTES = ["/auth", "/device", "/onboarding"] as const;

// Matches a listed route exactly, or anything nested under it — so a future
// `/onboarding/<step>` inherits the treatment instead of silently getting the
// shell back. The `/` boundary is what a bare `startsWith` would get wrong: it
// would claim `/devices` and `/onboarding-v2` along with the real routes.
export function isChromelessRoute(pathname: string): boolean {
  return CHROMELESS_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
