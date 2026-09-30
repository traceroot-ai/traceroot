import { EMBEDDING_MODEL, EMBEDDING_TIMEOUT_MS } from "./config.js";

export interface EmbeddingResult {
  vectors: number[][];
  inputTokens: number;
}

/** Inputs per request; the API accepts more, this keeps one request small. */
const MAX_BATCH = 100;
/** Retries after the first attempt, for 429 and 5xx only. */
const MAX_RETRIES = 2;

/**
 * Embed texts with the OpenAI embeddings API, batching and keeping input order.
 * Errors carry the status and the API's message, never the key.
 */
export async function embedTexts(
  texts: string[],
  apiKey: string,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<EmbeddingResult> {
  const vectors: number[][] = [];
  let inputTokens = 0;
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await embedBatch(batch, apiKey, opts);
    vectors.push(...res.vectors);
    inputTokens += res.inputTokens;
  }
  return { vectors, inputTokens };
}

async function embedBatch(
  input: string[],
  apiKey: string,
  opts: { baseUrl?: string; timeoutMs?: number },
): Promise<EmbeddingResult> {
  const url = `${(opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/embeddings`;
  const body = JSON.stringify({ model: EMBEDDING_MODEL, input });
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? EMBEDDING_TIMEOUT_MS);
    timer.unref?.();
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err) {
      throw new Error(
        controller.signal.aborted
          ? `embedding request timed out (model=${EMBEDDING_MODEL})`
          : `embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) return parseEmbeddings(text, input.length);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`embedding request returned ${response.status}: ${errorDetail(text)}`);
    }
    await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
  }
}

function parseEmbeddings(text: string, expected: number): EmbeddingResult {
  const parsed = JSON.parse(text) as {
    data?: { index?: number; embedding?: unknown }[];
    usage?: { prompt_tokens?: number };
  };
  const rows = parsed.data ?? [];
  if (rows.length !== expected) {
    throw new Error(`embedding response has ${rows.length} vectors for ${expected} inputs`);
  }
  const vectors: number[][] = new Array(expected);
  rows.forEach((row, i) => {
    const index = typeof row.index === "number" ? row.index : i;
    if (index < 0 || index >= expected || vectors[index] !== undefined) {
      throw new Error(`embedding response has a missing or repeated index ${index}`);
    }
    if (!Array.isArray(row.embedding) || row.embedding.some((x) => typeof x !== "number")) {
      throw new Error(`embedding ${index} is not a number array`);
    }
    vectors[index] = row.embedding as number[];
  });
  return { vectors, inputTokens: parsed.usage?.prompt_tokens ?? 0 };
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message.slice(0, 200);
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}
