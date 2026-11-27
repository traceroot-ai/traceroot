import { lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { ADAPTER_DEFAULT_BASE_URL } from "./llm-providers.ts";

export class InvalidProviderUrlError extends Error {
  constructor() {
    super("Provider URL must use the adapter's trusted HTTPS endpoint");
    this.name = "InvalidProviderUrlError";
  }
}

const defaultEndpoints = new Map(
  Object.entries(ADAPTER_DEFAULT_BASE_URL).map(([adapter, value]) => [adapter, new URL(value)]),
);
const azureHostname =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/;

function parseProviderUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidProviderUrlError();
  }
  if (
    !/^[\u0021-\u007e]+$/.test(value) ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    value.includes("@") ||
    value.includes("#") ||
    isIP(url.hostname)
  ) {
    throw new InvalidProviderUrlError();
  }
  return url;
}

/** Resolve a BYOK base URL against the adapter's trusted vendor endpoint. */
export function resolveProviderBaseUrl(
  adapter: string,
  baseUrl?: string | null,
): string | undefined {
  // Bedrock uses the AWS SDK endpoint, not this field (including stale UI values).
  if (adapter === "amazon-bedrock") return undefined;
  const defaultUrl = defaultEndpoints.get(adapter);
  const value = baseUrl || defaultUrl?.href;
  if (!value) throw new InvalidProviderUrlError();
  const url = parseProviderUrl(value);
  const path = url.pathname.replace(/\/+$/, "");
  const trusted =
    adapter === "azure"
      ? azureHostname.test(url.hostname) && (path === "" || path === "/openai/v1")
      : defaultUrl &&
        url.hostname === defaultUrl.hostname &&
        path === defaultUrl.pathname.replace(/\/+$/, "");
  if (!trusted || value.includes("?")) throw new InvalidProviderUrlError();
  return url.origin + path;
}

// Block special-use IPv4 ranges; accept IPv6 only within global unicast and
// exclude its special-use transition, benchmarking and documentation ranges.
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedAddresses.addSubnet(network, prefix, "ipv6");
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");

const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    if (
      !addresses.length ||
      addresses.some(({ address, family }) => {
        const type = family === 4 ? "ipv4" : "ipv6";
        return (
          blockedAddresses.check(address, type) ||
          (family !== 4 && !globalUnicast.check(address, "ipv6"))
        );
      })
    ) {
      return callback(new InvalidProviderUrlError(), "");
    }
    if (options.all) return callback(null, addresses);
    const selected = addresses.find(({ family }) => !options.family || family === options.family);
    if (!selected) return callback(new InvalidProviderUrlError(), "");
    callback(null, selected.address, selected.family);
  });
};

const providerDispatcher = new Agent({ connect: { lookup: publicLookup } });

function isProviderHost(hostname: string): boolean {
  return (
    azureHostname.test(hostname) ||
    [...defaultEndpoints.values()].some((value) => value.hostname === hostname)
  );
}

let installedDispatcher: Dispatcher | undefined;

/** Apply the same connection policy to SDKs that use Node's global fetch. */
export function installProviderNetworkPolicy(): void {
  const current = getGlobalDispatcher();
  if (current === installedDispatcher) return;
  installedDispatcher = current.compose((dispatch) => (options, handler) => {
    if (!options.origin || !isProviderHost(new URL(options.origin).hostname)) {
      return dispatch(options, handler);
    }
    parseProviderUrl(String(options.origin));
    return providerDispatcher.dispatch(options, {
      onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
      onRequestUpgrade: (controller, status, headers, socket) =>
        handler.onRequestUpgrade?.(controller, status, headers, socket),
      onResponseStart: (controller, status, headers, statusMessage) => {
        // Stop before fetch sees Location and starts another request outside this host policy.
        if (status >= 300 && status < 400) {
          controller.abort(new InvalidProviderUrlError());
          return;
        }
        handler.onResponseStart?.(controller, status, headers, statusMessage);
      },
      onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
      onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
      onResponseError: (controller, error) => handler.onResponseError?.(controller, error),
    });
  });
  setGlobalDispatcher(installedDispatcher);
}

/** Fetch a vendor endpoint with address checks at socket lookup, without redirects. */
export async function providerFetch(url: string, init: RequestInit): Promise<Response> {
  const parsed = parseProviderUrl(url);
  if (!isProviderHost(parsed.hostname)) {
    throw new InvalidProviderUrlError();
  }
  const options = { ...init, redirect: "error" as const, dispatcher: providerDispatcher };
  return fetch(url, options);
}
