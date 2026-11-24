import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";

/**
 * Largest response header block accepted when fetching a client metadata
 * document. Node's default is 16 KiB, and some assistants serve their document
 * from a host that sends nearly that much in headers alone (cookies, security
 * policies), so a small header change on their side would break every sign-in
 * through the document. The body stays capped by the plugin (5 KB).
 */
export const METADATA_MAX_HEADER_BYTES = 64 * 1024;

const NO_BODY_STATUSES = new Set([204, 205, 304]);

function toHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.append(name, value);
  }
  return headers;
}

type Deps = { lookup: typeof dnsLookup; request: typeof httpsRequest };

/**
 * Fetch a client metadata document (or its jwks_uri) the way the cimd plugin's
 * own Node transport does, plus a larger header limit: HTTPS only, GET or HEAD
 * only, every DNS answer must be public, the first answer is pinned for the
 * connection while the hostname stays the Host, SNI and certificate identity,
 * and redirects are returned, never followed. The plugin applies the timeout
 * (through the signal) and the body cap.
 */
export function pinnedMetadataFetch(deps: Deps = { lookup: dnsLookup, request: httpsRequest }) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const webRequest = new Request(input, init);
    const url = new URL(webRequest.url);
    if (url.protocol !== "https:") throw new TypeError("metadata fetch requires an HTTPS URL");
    if (webRequest.method !== "GET" && webRequest.method !== "HEAD") {
      throw new TypeError("metadata fetch supports only GET and HEAD");
    }
    const addresses = await deps.lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) throw new TypeError("metadata hostname returned no DNS addresses");
    for (const { address } of addresses) {
      if (!isPublicRoutableHost(address)) {
        throw new TypeError("metadata hostname must resolve only to public-routable addresses");
      }
    }
    const pinned = addresses[0];
    // Only the validated address, in whichever form Node asks for.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const headers: Record<string, string> = Object.fromEntries(webRequest.headers.entries());
    headers.host = url.host;
    const signal = init?.signal ?? webRequest.signal;

    return new Promise<Response>((resolve, reject) => {
      const outgoing = deps.request(
        url,
        {
          agent: false,
          headers,
          method: webRequest.method,
          maxHeaderSize: METADATA_MAX_HEADER_BYTES,
          servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 ? url.hostname : undefined,
          signal: signal ?? undefined,
          lookup: pinnedLookup,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          const body =
            webRequest.method === "HEAD" || NO_BODY_STATUSES.has(status)
              ? null
              : (Readable.toWeb(response) as ReadableStream);
          try {
            resolve(
              new Response(body, {
                headers: toHeaders(response.headers),
                status,
                statusText: response.statusMessage,
              }),
            );
          } catch (error) {
            response.destroy();
            reject(error);
          }
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
  };
}
