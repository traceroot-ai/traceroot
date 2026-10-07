// Presence is only a hint to offer recovery, never authorization. The stop
// endpoint verifies the cookie signature and original session before restoring.
export function hasSupportRestoreCookie(headers: Headers) {
  return /(?:^|;\s*)(?:__Secure-)?better-auth\.(?:support_original|admin_session)=/.test(
    headers.get("cookie") ?? "",
  );
}
