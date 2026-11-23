/**
 * A case's name in the comparison URL (`?case=`). A case id key (`id:tc_…`) is short and
 * goes in as it is. An input key (`input:<canonical input>`) can be as long as the input
 * itself, so it goes in as a 64-bit hash of the key instead (`h:<16 hex>`). Either kind
 * resolves back to its row; a token no case has resolves to nothing. The key comes from
 * `canonicalInputKey`, so a change to its canonical form changes the hashes: an older link
 * then opens the comparison with no case open.
 */
import type { CaseRow } from "./model";

/** Two 32-bit lanes over the key's UTF-16 code units, cross-mixed at the end
 *  (cyrb53's construction, kept to the full 64 bits). Stable across engines and loads,
 *  so a link shared today opens the same case tomorrow. */
function hash64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h2) + hex(h1);
}

export function caseUrlToken(key: string): string {
  return key.startsWith("id:") ? key : `h:${hash64(key)}`;
}

// Hashing every input key is linear in the inputs' size, so each case list (immutable
// for the life of a comparison model) is indexed once.
const indexes = new WeakMap<readonly CaseRow[], Map<string, CaseRow>>();

export function findCaseByToken(cases: readonly CaseRow[], token: string): CaseRow | null {
  let index = indexes.get(cases);
  if (!index) {
    index = new Map();
    // Keep-first, so a hash collision opens the earlier row rather than a later one.
    for (const c of cases) {
      const t = caseUrlToken(c.key);
      if (!index.has(t)) index.set(t, c);
    }
    indexes.set(cases, index);
  }
  return index.get(token) ?? null;
}
