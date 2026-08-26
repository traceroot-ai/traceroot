/**
 * Cross-layer drift guard (Zod side).
 *
 * The public eval reporting contract lives in two places: the Zod schemas here
 * (the Prisma-owned Next.js control plane validates with them) and the Pydantic
 * models in the FastAPI gateway (`backend/rest/schemas/eval.py`). Both must agree
 * on exactly which SDK payloads are valid, or the gateway would accept requests
 * the control plane rejects (or vice-versa) — and the gateway forwards the raw
 * request bytes upstream, so its validation is the only place that can catch it.
 *
 * This file and `tests/rest/test_eval_contract_parity.py` run the same two halves
 * against their own layer:
 *
 * 1. BEHAVIOURAL — replay the shared payloads in `eval-contract-parity-fixtures.json`
 *    and assert identical accept/reject verdicts, plus identical normalization of the
 *    values that degrade rather than reject.
 * 2. STRUCTURAL — reduce every schema to a language-neutral descriptor and compare it
 *    against the shared roster in `eval-contract-shape.json`. Fixtures alone cannot
 *    catch a one-sided OPTIONAL field or bound (no fixture sends it, so every verdict
 *    is unchanged and both suites stay green); the roster makes any field added,
 *    removed or retyped on one layer only red by construction, and its coverage
 *    assertion makes a NEW schema fail until it is listed.
 */
import { describe, it, expect } from "vitest";
import * as contract from "../eval-contract.ts";
import {
  RegisterRunRequestSchema,
  UpsertResultRequestSchema,
  CompleteRunRequestSchema,
} from "../eval-contract.ts";
import { contractShapes, type Shape } from "./contract-shape.ts";
import fixtures from "./eval-contract-parity-fixtures.json" with { type: "json" };
import roster from "./eval-contract-shape.json" with { type: "json" };

const SCHEMAS = {
  register: RegisterRunRequestSchema,
  upsert_result: UpsertResultRequestSchema,
  complete: CompleteRunRequestSchema,
} as const;

type Group = keyof typeof SCHEMAS;
type Case = { name: string; payload: unknown; expect?: Record<string, unknown> };
type Bucket = { valid: Case[]; invalid: Case[]; degraded?: Case[] };

const buckets = fixtures as unknown as Record<string, Bucket>;

/**
 * Read `a.0.b` out of a parsed payload (list indices are numeric segments). A key Zod
 * stripped reads as null, matching how the pydantic side reads a field that is not set
 * — the two layers spell "not there" differently and a fixture cannot say `undefined`.
 */
function at(value: unknown, path: string): unknown {
  return (
    path
      .split(".")
      .reduce<unknown>(
        (acc, segment) => (acc as Record<string, unknown> | undefined)?.[segment],
        value,
      ) ?? null
  );
}

describe("eval reporting contract parity (Zod)", () => {
  for (const group of Object.keys(SCHEMAS) as Group[]) {
    const schema = SCHEMAS[group];
    const bucket = buckets[group];

    it(`accepts every representative valid ${group} payload`, () => {
      for (const c of bucket.valid) {
        const result = schema.safeParse(c.payload);
        expect(result.success, `${group}/${c.name} should be ACCEPTED`).toBe(true);
      }
    });

    it(`rejects every representative invalid ${group} payload`, () => {
      for (const c of bucket.invalid) {
        const result = schema.safeParse(c.payload);
        expect(result.success, `${group}/${c.name} should be REJECTED`).toBe(false);
      }
    });

    // Accept/reject parity is not enough where a layer NORMALIZES instead: a
    // display-only vocabulary degrades an unrecognised member to null rather than
    // failing the whole run, and a non-strict scorer strips unknown keys. Both layers
    // must land on the same value, or the control plane stores something the gateway
    // never saw.
    it(`degrades every ${group} payload the same way`, () => {
      for (const c of bucket.degraded ?? []) {
        const result = schema.safeParse(c.payload);
        expect(result.success, `${group}/${c.name} should be ACCEPTED`).toBe(true);
        if (!result.success) continue;
        for (const [path, expected] of Object.entries(c.expect ?? {})) {
          expect(at(result.data, path), `${group}/${c.name} at ${path}`).toEqual(expected);
        }
      }
    });
  }
});

describe("eval reporting contract shape (Zod)", () => {
  const shapes = contractShapes(contract as Record<string, unknown>);
  const paired = roster.paired as unknown as Record<string, Shape>;
  const zodOnly = roster.zod_only as unknown as Record<string, Shape>;
  const pydanticOnly = roster.pydantic_only as unknown as Record<string, Shape>;

  // An unlisted schema must FAIL, not silently pass: a schema with no roster entry is
  // a schema with zero cross-layer coverage. Listing it (in `paired`, or in `zod_only`
  // with the reason it has no gateway counterpart) is the deliberate act asserted on.
  it("the roster covers every exported contract schema", () => {
    expect(Object.keys(shapes).sort()).toEqual(
      [...Object.keys(paired), ...Object.keys(zodOnly)].sort(),
    );
  });

  for (const [name, expected] of [...Object.entries(paired), ...Object.entries(zodOnly)]) {
    it(`${name} matches the roster`, () => {
      expect(shapes[name]).toEqual(expected);
    });
  }

  // The recorded asymmetry must stay real: writing a Zod schema for one of these is
  // the moment its entry has to be promoted to `paired` and compared field-for-field.
  it("the gateway-only models have no Zod counterpart", () => {
    for (const name of Object.keys(pydanticOnly)) {
      expect(shapes[name], `${name} now exists on both layers`).toBeUndefined();
    }
  });
});
