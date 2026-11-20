/**
 * Fit a JSON result into a character budget without breaking it.
 *
 * A result cut mid-string is not JSON any more: a model has to guess where the
 * data stopped, and a client cannot parse it. Instead the value is shrunk
 * structurally until its encoding fits:
 *
 * 1. every string longer than the per-value cap is cut, ending in a marker
 *    that says how many characters went;
 * 2. while still too long, the largest array with more than one item loses
 *    items from its tail, and `_truncated` at the root records how many went
 *    from which path;
 * 3. when no array can shrink, the string cap halves and the steps repeat.
 *
 * The output always parses, and `_hint` says how to ask for less.
 */

/** Strings longer than this are cut first, whatever the budget. */
export const DEFAULT_MAX_VALUE_CHARS = 10_000;

/** The string cap never goes below this; a value cut further says nothing. */
const MIN_VALUE_CHARS = 200;

/** The fitted result. `value` is what `text` encodes. */
export interface FittedResult {
  value: unknown;
  text: string;
  truncated: boolean;
}

export interface FitOptions {
  /** Per-string cap applied before anything is dropped. */
  maxValueChars?: number;
  /** Says how to ask for less; stored as `_hint` when anything was cut. */
  hint?: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Encode `value`, shrinking it as described above when it is longer than `limit`. */
export function fitToBudget(value: unknown, limit: number, options: FitOptions = {}): FittedResult {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= limit) {
    return { value, text, truncated: false };
  }
  const hint = options.hint ?? "Narrow the request and call again.";
  // A fresh copy to cut, from the encoding (results are JSON from the API).
  let root = JSON.parse(text) as Json;
  // A list at the root has no place for markers, so it moves under `items`.
  if (Array.isArray(root)) {
    root = { items: root };
  }
  const dropped: Record<string, number> = {};
  const finish = (): FittedResult => {
    const fitted = isObject(root)
      ? {
          ...root,
          ...(Object.keys(dropped).length > 0 ? { _truncated: dropped } : {}),
          _hint: hint,
        }
      : root;
    return { value: fitted, text: JSON.stringify(fitted), truncated: true };
  };

  let cap = Math.max(options.maxValueChars ?? DEFAULT_MAX_VALUE_CHARS, MIN_VALUE_CHARS);
  root = capStrings(root, cap);
  // Each round either drops array items or halves the cap, so it terminates;
  // the bound is a guard, not the expected exit.
  for (let round = 0; round < 200; round++) {
    const attempt = finish();
    if (attempt.text.length <= limit) {
      return attempt;
    }
    const overflow = attempt.text.length - limit;
    const largest = largestArray(root);
    if (largest) {
      // The attempt already carries the markers; a new path adds its own entry.
      const entry = largest.path in dropped ? 0 : JSON.stringify(largest.path).length + 8;
      const removed = dropTail(largest, overflow + entry);
      dropped[largest.path] = (dropped[largest.path] ?? 0) + removed;
      continue;
    }
    if (cap > MIN_VALUE_CHARS) {
      cap = Math.max(Math.floor(cap / 2), MIN_VALUE_CHARS);
      root = capStrings(root, cap);
      continue;
    }
    break;
  }
  // Nothing left to shrink structurally (a huge object of short fields): say so
  // rather than return a partial object.
  const stub = {
    _truncated: true,
    _hint: `The result (${text.length} characters) was too large to return even in part. ${hint}`,
  };
  const stubText = JSON.stringify(stub);
  if (stubText.length <= limit) {
    return { value: stub, text: stubText, truncated: true };
  }
  const minimal = { _truncated: true };
  return { value: minimal, text: JSON.stringify(minimal), truncated: true };
}

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cut every string longer than `cap`, keys untouched. */
function capStrings(value: Json, cap: number): Json {
  if (typeof value === "string") {
    if (value.length <= cap) return value;
    const kept = value.slice(0, cap);
    return `${kept}…[truncated ${value.length - cap} chars]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => capStrings(item, cap));
  }
  if (isObject(value)) {
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = capStrings(item, cap);
    }
    return out;
  }
  return value;
}

interface ArrayAt {
  path: string;
  array: Json[];
  /** Encoded length of each item. */
  sizes: number[];
  size: number;
}

/** The largest array (by encoded length) that still has more than one item. */
function largestArray(root: Json): ArrayAt | undefined {
  let best: ArrayAt | undefined;
  const visit = (value: Json, path: string): number => {
    if (Array.isArray(value)) {
      const sizes = value.map((item, index) => visit(item, `${path}[${index}]`));
      const size = 2 + sizes.reduce((sum, n) => sum + n, 0) + Math.max(value.length - 1, 0);
      if (value.length > 1 && (!best || size > best.size)) {
        best = { path, array: value, sizes, size };
      }
      return size;
    }
    if (isObject(value)) {
      const entries = Object.entries(value);
      let size = 2 + Math.max(entries.length - 1, 0);
      for (const [key, item] of entries) {
        size += JSON.stringify(key).length + 1 + visit(item, path === "" ? key : `${path}.${key}`);
      }
      return size;
    }
    return JSON.stringify(value).length;
  };
  visit(root, "");
  return best;
}

/** Remove tail items worth at least `chars`, keeping the first; returns how many went. */
function dropTail(target: ArrayAt, chars: number): number {
  let removed = 0;
  let freed = 0;
  while (target.array.length > 1 && freed < chars) {
    target.array.pop();
    // The item and the comma before it.
    freed += target.sizes[target.array.length]! + 1;
    removed++;
  }
  return removed;
}
