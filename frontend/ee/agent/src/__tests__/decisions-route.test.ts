import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionsRoute } from "../decisions-route.js";
import { pendingDecisions, userSkipReason } from "../pending-decisions.js";
import { getSession } from "../session.js";

vi.mock("../session.js", () => ({
  getSession: vi.fn(),
}));

const mockedGetSession = vi.mocked(getSession);

function ownSession(sessionId: string) {
  mockedGetSession.mockResolvedValue({ id: sessionId } as never);
}

function park(sessionId: string, toolName = "create_detector") {
  return pendingDecisions.park({
    sessionId,
    toolCallId: "tc-1",
    toolName,
    args: { name: "latency" },
  });
}

function post(sessionId: string, body: unknown) {
  return decisionsRoute.request(`/api/v1/projects/p1/sessions/${sessionId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": "u1" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  // No test may leave a parked promise behind.
  pendingDecisions.releaseSession("route-s1", "test cleanup");
  pendingDecisions.releaseSession("route-s2", "test cleanup");
});

describe("POST .../sessions/:sessionId/decisions", () => {
  it("resolves a parked decision as create", async () => {
    ownSession("route-s1");
    const { decisionId, outcome } = park("route-s1");

    const res = await post("route-s1", { decisionId, action: "create" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    await expect(outcome).resolves.toEqual({ action: "create" });
    expect(pendingDecisions.pendingCount("route-s1")).toBe(0);
  });

  it("resolves skip with the user-skipped reason", async () => {
    ownSession("route-s1");
    const { decisionId, outcome } = park("route-s1", "create_widget");

    const res = await post("route-s1", { decisionId, action: "skip" });
    expect(res.status).toBe(200);
    await expect(outcome).resolves.toEqual({
      action: "skip",
      reason: userSkipReason("create_widget"),
    });
  });

  it("resolves revise carrying the text", async () => {
    ownSession("route-s1");
    const { decisionId, outcome } = park("route-s1");

    const res = await post("route-s1", { decisionId, action: "revise", text: "smaller widget" });
    expect(res.status).toBe(200);
    await expect(outcome).resolves.toEqual({ action: "revise", text: "smaller widget" });
  });

  it("404s an unknown or expired decisionId", async () => {
    ownSession("route-s1");
    const res = await post("route-s1", { decisionId: "never-existed", action: "create" });
    expect(res.status).toBe(404);
  });

  it("404s when the caller does not own the session — decision stays parked", async () => {
    // getSession also rejects an owned session addressed through another
    // project's path (see session-tenancy tests); the route must scope the
    // lookup to the URL's project so that mismatch lands here as the same 404.
    mockedGetSession.mockResolvedValue(null as never);
    const { decisionId } = park("route-s1");

    const res = await post("route-s1", { decisionId, action: "create" });
    expect(res.status).toBe(404);
    expect(mockedGetSession).toHaveBeenCalledWith("route-s1", "u1", "p1");
    expect(pendingDecisions.pendingCount("route-s1")).toBe(1);
  });

  it("404s a decision that belongs to a different session than the URL's", async () => {
    ownSession("route-s1");
    const { decisionId } = park("route-s2");

    const res = await post("route-s1", { decisionId, action: "create" });
    expect(res.status).toBe(404);
    expect(pendingDecisions.pendingCount("route-s2")).toBe(1);
  });

  it("409s a double decide — the first decision wins", async () => {
    ownSession("route-s1");
    const { decisionId, outcome } = park("route-s1");

    expect((await post("route-s1", { decisionId, action: "create" })).status).toBe(200);
    expect((await post("route-s1", { decisionId, action: "skip" })).status).toBe(409);
    await expect(outcome).resolves.toEqual({ action: "create" });
  });

  it("400s an unknown action, a missing decisionId, and a non-JSON body", async () => {
    ownSession("route-s1");
    expect((await post("route-s1", { decisionId: "d1", action: "approve" })).status).toBe(400);
    expect((await post("route-s1", { action: "create" })).status).toBe(400);
    expect((await post("route-s1", "not json")).status).toBe(400);
  });

  it("400s a body that is valid JSON but not an object", async () => {
    ownSession("route-s1");
    expect((await post("route-s1", null)).status).toBe(400);
    expect((await post("route-s1", [])).status).toBe(400);
  });
});
