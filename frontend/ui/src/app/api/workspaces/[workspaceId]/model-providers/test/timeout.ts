// Connectivity checks must be bounded: a provider host — or a user-supplied
// baseUrl — that accepts the socket but never responds (or stalls mid-body)
// would otherwise leave the request handler hanging indefinitely.
const DEFAULT_TEST_TIMEOUT_MS = 10_000;
// Guard against a misconfigured env pinning the handler open for minutes.
const MAX_TEST_TIMEOUT_MS = 60_000;

// Parse MODEL_PROVIDER_TEST_TIMEOUT_MS safely: anything non-finite or below 1ms
// (covers zero, negatives, and sub-1ms fractions that would floor to 0) falls
// back to the default, absurdly large values are capped, and a fractional value
// is floored to whole milliseconds.
export function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_TEST_TIMEOUT_MS;
  }
  return Math.floor(Math.min(parsed, MAX_TEST_TIMEOUT_MS));
}

export const TEST_CONNECTION_TIMEOUT_MS = resolveTimeoutMs(
  process.env.MODEL_PROVIDER_TEST_TIMEOUT_MS,
);

// A deadline breach, as opposed to a transport failure. Callers surface the two
// differently: a timeout message is meaningful on its own, while a transport
// error's raw text belongs in the detail line rather than the headline.
export class TimeoutError extends Error {
  constructor(message?: string) {
    super(message);
    // Without this, `name` inherits "Error" and serialized logs/stack traces read
    // "Error: Connection timed out ...", indistinguishable from any other failure.
    this.name = "TimeoutError";
  }
}

// Run the full logical provider check under a single deadline. The timer stays
// armed until `operation` settles, so it bounds not just the initial fetch() but
// any subsequent response-body reads the operation performs.
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = TEST_CONNECTION_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TimeoutError(`Connection timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
