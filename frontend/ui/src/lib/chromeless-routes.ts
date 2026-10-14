// The surfaces that render on their own, with no app shell around them: no
// workspace rail, no header bar, no AI panel — just the page, centred on an
// otherwise empty background. AppLayout is the only consumer; this module
// exists so the set is one explicit list with the reason for each entry next to
// it, rather than a condition buried in a component.
//
// `/auth/*` and `/device` are reachable while SIGNED OUT. Wrapping them in the
// authenticated shell renders a bogus "User" menu and a workspace rail around
// an account that may not even exist yet.
const CHROMELESS_ROUTES = ["/auth", "/device"] as const;

// Matches a listed route exactly, or anything nested under it. The `/` boundary
// is what a bare `startsWith` would get wrong: it would claim `/devices` along
// with the real route.
export function isChromelessRoute(pathname: string): boolean {
  return CHROMELESS_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
