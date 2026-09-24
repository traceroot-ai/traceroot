import { NextResponse } from "next/server";

/**
 * The outcome of a project-keyed evaluation read, independent of how its caller
 * authenticated.
 *
 * The same read is served to an API key (the public route) and to the backend on the
 * agent's behalf (the secret-authed internal route). Both resolve the project first and
 * then call one function, so the function answers with a result instead of a response:
 * each route turns it into HTTP the same way, and the error strings cannot drift between
 * the two surfaces.
 */
export type EvalReadResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: 400 | 403 | 404; error: string };

export function evalReadResponse<T>(result: EvalReadResult<T>) {
  return result.ok
    ? NextResponse.json(result.body)
    : NextResponse.json({ error: result.error }, { status: result.status });
}
