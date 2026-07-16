/**
 * Cross-layer drift guard (Zod side).
 *
 * The public eval reporting contract lives in two places: the Zod schemas here
 * (the Prisma-owned Next.js control plane validates with them) and the Pydantic
 * models in the FastAPI gateway (`backend/rest/schemas/eval.py`). Both must agree
 * on exactly which SDK payloads are valid, or the gateway would accept requests
 * the control plane rejects (or vice-versa).
 *
 * This test and `tests/rest/test_eval_contract_parity.py` load the SAME fixture
 * file and assert the SAME accept/reject verdicts. If someone edits one schema
 * without the other, one side goes red.
 */
import { describe, it, expect } from "vitest";
import {
  RegisterRunRequestSchema,
  UpsertResultRequestSchema,
  CompleteRunRequestSchema,
} from "../eval-contract.ts";
import fixtures from "./eval-contract-parity-fixtures.json" with { type: "json" };

const SCHEMAS = {
  register: RegisterRunRequestSchema,
  upsert_result: UpsertResultRequestSchema,
  complete: CompleteRunRequestSchema,
} as const;

type Group = keyof typeof SCHEMAS;
type Case = { name: string; payload: unknown };

describe("eval reporting contract parity (Zod)", () => {
  for (const group of Object.keys(SCHEMAS) as Group[]) {
    const schema = SCHEMAS[group];
    const bucket = (fixtures as Record<string, { valid: Case[]; invalid: Case[] }>)[group];

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
  }
});
