/**
 * Size-bounded JSON body reading for the public evaluation routes.
 *
 * `request.json()` buffers and parses the whole body with no ceiling — the 4 MB
 * `bodyParser.sizeLimit` default is a Pages Router feature and does not apply to
 * Route Handlers. A publish carrying unbounded `input` strings would therefore be
 * materialized in full before any per-item check could reject it, so the limit has
 * to be enforced on the wire: refuse an oversized `Content-Length` outright, and
 * stop reading the stream the moment it exceeds the ceiling.
 */

export type LimitedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

const tooLarge = (maxBytes: number): LimitedJsonResult => ({
  ok: false,
  status: 413,
  error: `Request body exceeds ${maxBytes} bytes`,
});

/** Read and parse a JSON body, refusing anything over `maxBytes`. */
export async function readLimitedJson(
  request: Request,
  maxBytes: number,
): Promise<LimitedJsonResult> {
  const declared = Number(request.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge(maxBytes);

  const stream = request.body;
  if (!stream) {
    // No readable stream (an already-buffered body): fall back to the parsed form.
    try {
      return { ok: true, value: await request.json() };
    } catch {
      return { ok: false, status: 400, error: "Invalid JSON" };
    }
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "Could not read the request body" };
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(joined)) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
}
