import { Hono } from "hono";
import { pendingDecisions, type DecisionAction } from "./pending-decisions.js";
import { getSession } from "./session.js";

const DECISION_ACTIONS = new Set<DecisionAction>(["create", "skip", "revise"]);

function isDecisionAction(value: unknown): value is DecisionAction {
  return typeof value === "string" && DECISION_ACTIONS.has(value as DecisionAction);
}

/**
 * The user's answer to a parked confirmation card:
 * create executes the tool call unchanged, skip declines it, revise declines
 * it carrying the user's text so the model can re-propose.
 *
 * 404 covers every shape of "not yours or not here" — unknown/expired
 * decisionId, a session the caller cannot see, and a decision parked under a
 * different session — so callers cannot probe. 409 means someone already
 * decided (first decision wins).
 */
export const decisionsRoute = new Hono();

decisionsRoute.post("/api/v1/projects/:projectId/sessions/:sessionId/decisions", async (c) => {
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  const userId = c.req.header("x-user-id") || "";

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  // JSON null and arrays parse fine but have no fields to read, so they are
  // rejected here rather than left to throw on the destructuring below.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const { decisionId, action, text } = body as {
    decisionId?: unknown;
    action?: unknown;
    text?: unknown;
  };
  if (typeof decisionId !== "string" || !decisionId || !isDecisionAction(action)) {
    return c.json({ error: 'decisionId and action ("create" | "skip" | "revise") required' }, 400);
  }

  // Same ownership check as the messages route: the caller must own the
  // session (or have projectId scope on a system session).
  const session = await getSession(sessionId, userId, projectId);
  if (!session) {
    return c.json({ error: "session not found" }, 404);
  }

  const result = pendingDecisions.decide(decisionId, sessionId, {
    action,
    text: typeof text === "string" ? text : undefined,
  });
  if (result === "unknown") {
    return c.json({ error: "decision not found" }, 404);
  }
  if (result === "already_decided") {
    return c.json({ error: "decision already made" }, 409);
  }
  return c.json({ ok: true });
});
