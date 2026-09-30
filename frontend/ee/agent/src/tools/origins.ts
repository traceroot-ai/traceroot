/**
 * The two origins the agent knows the web app by.
 *
 * Server-to-server calls (internal routes, GitHub access checks) go to the
 * address the service can reach, which in a compose deployment is the web
 * container's name. Links shown to a person must use the address a browser
 * can reach; the backend draws the same distinction for trace links. Read at
 * call time so a test can set either without reloading the module. A
 * trailing slash on either setting is dropped so paths appended with a
 * leading slash never produce "//".
 */
export function internalUiUrl(): string {
  return stripTrailingSlash(process.env.TRACEROOT_UI_URL || "http://localhost:3000");
}

export function publicUiUrl(): string {
  return stripTrailingSlash(
    process.env.TRACEROOT_PUBLIC_UI_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3000",
  );
}

function stripTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, "");
}
