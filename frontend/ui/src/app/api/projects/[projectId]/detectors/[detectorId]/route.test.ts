import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorFindFirstMock = vi.fn();
const detectorUpdateMock = vi.fn();
const detectorDeleteMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  prisma: {
    detector: {
      findFirst: (...args: unknown[]) => detectorFindFirstMock(...args),
      update: (...args: unknown[]) => detectorUpdateMock(...args),
      delete: (...args: unknown[]) => detectorDeleteMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));

import { Role } from "@traceroot/core";
import { PATCH, DELETE } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", detectorId: "det-1" }) };
}

beforeEach(() => {
  detectorFindFirstMock.mockReset();
  detectorUpdateMock.mockReset();
  detectorDeleteMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
  detectorFindFirstMock.mockResolvedValue({ id: "det-1", projectId: "proj-1" });
  detectorUpdateMock.mockResolvedValue({ id: "det-1" });
  detectorDeleteMock.mockResolvedValue({ id: "det-1" });
});

describe("PATCH .../detectors/[detectorId] — role gating", () => {
  it("returns 403 for a VIEWER-role member and never updates", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Requires MEMBER role or higher" }) },
    });

    const res = await PATCH(makeRequest({ name: "Renamed" }), makeParams());

    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", Role.MEMBER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("Requires MEMBER role or higher");
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("lets a MEMBER-role member update a detector", async () => {
    const res = await PATCH(makeRequest({ name: "Renamed" }), makeParams());

    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", Role.MEMBER);
    expect(res.status).toBe(200);
    expect(detectorUpdateMock).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH .../detectors/[detectorId] — name conflicts", () => {
  /** A duck-typed Prisma unique-violation naming the violated constraint. */
  const p2002 = (target: unknown) =>
    Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });

  it("returns 409 when a rename collides on the per-project unique index (index-name target)", async () => {
    detectorUpdateMock.mockRejectedValue(p2002("uq_detector_project_name"));
    const res = await PATCH(makeRequest({ name: "Taken" }), makeParams());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "A detector with this name already exists",
    );
  });

  it("returns 409 when the unique violation is reported as the (projectId, name) fields", async () => {
    detectorUpdateMock.mockRejectedValue(p2002(["projectId", "name"]));
    const res = await PATCH(makeRequest({ name: "Taken" }), makeParams());
    expect(res.status).toBe(409);
  });

  it("rethrows a trigger-upsert P2002 even when the PATCH also carries a name", async () => {
    detectorUpdateMock.mockRejectedValue(p2002("detector_triggers_detector_id_key"));
    await expect(
      PATCH(makeRequest({ name: "Renamed", triggerConditions: [] }), makeParams()),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rethrows a P2002 that names no constraint at all", async () => {
    detectorUpdateMock.mockRejectedValue(p2002(undefined));
    await expect(PATCH(makeRequest({ name: "Renamed" }), makeParams())).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("propagates non-P2002 update failures", async () => {
    detectorUpdateMock.mockRejectedValue(new Error("Database connection lost"));
    await expect(PATCH(makeRequest({ name: "Renamed" }), makeParams())).rejects.toThrow(
      "Database connection lost",
    );
  });
});

describe("DELETE .../detectors/[detectorId] — role gating", () => {
  it("returns 403 for a VIEWER-role member and never deletes", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Requires MEMBER role or higher" }) },
    });

    const res = await DELETE(makeRequest({}), makeParams());

    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", Role.MEMBER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("Requires MEMBER role or higher");
    expect(detectorDeleteMock).not.toHaveBeenCalled();
  });

  it("lets a MEMBER-role member delete a detector", async () => {
    const res = await DELETE(makeRequest({}), makeParams());

    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", Role.MEMBER);
    expect(res.status).toBe(200);
    expect(detectorDeleteMock).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH .../detectors/[detectorId] — trigger conditions", () => {
  it("upserts a condition on an offered field", async () => {
    const conditions = [{ field: "metadata", op: "contains", value: "acme", key: "tenant" }];
    const res = await PATCH(makeRequest({ triggerConditions: conditions }), makeParams());

    expect(res.status).toBe(200);
    expect(detectorUpdateMock.mock.calls[0][0].data.trigger.upsert.update.conditions).toEqual(
      conditions,
    );
  });

  it("refuses to save a half-filled condition carried over from an older detector", async () => {
    // A row saved before the registry validation existed can hold an empty
    // value; saving it back would store a condition that matches nothing.
    const res = await PATCH(
      makeRequest({ triggerConditions: [{ field: "environment", op: "=", value: "" }] }),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("refuses an operator the field does not offer", async () => {
    const res = await PATCH(
      makeRequest({ triggerConditions: [{ field: "cost", op: "contains", value: "1" }] }),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });
});
