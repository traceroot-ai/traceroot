import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createLabel: vi.fn(),
  createReceipt: vi.fn(),
  findUniqueReceipt: vi.fn(),
  groupBy: vi.fn(),
  transaction: vi.fn(),
  verifyInternalSecret: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    label: { groupBy: mocks.groupBy },
    sdkLabelReceipt: { findUnique: mocks.findUniqueReceipt },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: mocks.verifyInternalSecret,
  errorResponse: (error: string, status: number) => Response.json({ error }, { status }),
  successResponse: (data: unknown) => Response.json(data),
}));

import { GET, POST } from "./route";

const assignment = {
  projectId: "project-a",
  traceId: "trace-a",
  spanId: "span-a",
  value: "Needs review",
  authorId: "customer-42",
  idempotencyKey: "sdk-event-a",
};

function write(body: object) {
  return POST(
    new Request("http://localhost/api/internal/labels", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verifyInternalSecret.mockReturnValue(true);
  mocks.transaction.mockImplementation((callback) =>
    callback({
      label: { create: mocks.createLabel },
      sdkLabelReceipt: { create: mocks.createReceipt },
    }),
  );
});

describe("internal label writes", () => {
  it("returns the winning ID when a concurrent identical call conflicts", async () => {
    mocks.createReceipt
      .mockResolvedValueOnce({ labelId: "winning-label" })
      .mockRejectedValue({ code: "P2002" });
    mocks.findUniqueReceipt.mockResolvedValue({ ...assignment, labelId: "winning-label" });

    const responses = await Promise.all([write(assignment), write(assignment)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { id: "winning-label" },
      { id: "winning-label" },
    ]);
    expect(mocks.findUniqueReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId_idempotencyKey: { projectId: "project-a", idempotencyKey: "sdk-event-a" },
        },
      }),
    );
    expect(mocks.createLabel).toHaveBeenCalledExactlyOnceWith({
      data: {
        id: "winning-label",
        projectId: "project-a",
        traceId: "trace-a",
        spanId: "span-a",
        value: "Needs review",
        authorId: "customer-42",
        source: "SDK",
      },
      select: { id: true },
    });
  });

  it.each([
    { traceId: "trace-b" },
    { spanId: "span-b" },
    { value: "Other" },
    { authorId: "customer-43" },
  ])("rejects an idempotency key reused with a changed assignment (%o)", async (change) => {
    mocks.createReceipt.mockRejectedValue({ code: "P2002" });
    mocks.findUniqueReceipt.mockResolvedValue({ ...assignment, labelId: "winning-label" });

    expect((await write({ ...assignment, ...change })).status).toBe(409);
    expect(mocks.createLabel).not.toHaveBeenCalled();
  });

  it("accepts separate keys for the same author and target", async () => {
    mocks.createReceipt
      .mockResolvedValueOnce({ labelId: "first-label" })
      .mockResolvedValueOnce({ labelId: "second-label" });

    expect(await (await write(assignment)).json()).toEqual({ id: "first-label" });
    expect(await (await write({ ...assignment, idempotencyKey: "sdk-event-b" })).json()).toEqual({
      id: "second-label",
    });
    expect(mocks.createLabel).toHaveBeenCalledTimes(2);
  });

  it("replays a deleted assignment even if the catalog name is reused", async () => {
    mocks.createReceipt.mockRejectedValue({ code: "P2002" });
    mocks.findUniqueReceipt.mockResolvedValue({ ...assignment, labelId: "deleted-assignment" });
    mocks.createLabel.mockResolvedValue({ id: "replacement-assignment" });

    const response = await write(assignment);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "deleted-assignment" });
    expect(mocks.createLabel).not.toHaveBeenCalled();
  });

  it("replays a legacy receipt that predates author attribution", async () => {
    mocks.createReceipt.mockRejectedValue({ code: "P2002" });
    mocks.findUniqueReceipt.mockResolvedValue({
      ...assignment,
      authorId: null,
      labelId: "legacy-label",
    });

    expect(await (await write(assignment)).json()).toEqual({ id: "legacy-label" });
    expect(mocks.createLabel).not.toHaveBeenCalled();
  });

  it("returns 404 for a new key when the catalog label is missing", async () => {
    mocks.createReceipt.mockResolvedValue({ labelId: "unused-assignment" });
    mocks.createLabel.mockRejectedValue({ code: "P2003" });

    const response = await write(assignment);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project label not found" });
  });
});

it("looks up a bounded set of distinct trace IDs by project and label", async () => {
  const groups = Array.from({ length: 501 }, (_, index) => ({ traceId: `trace-${index}` }));
  mocks.groupBy.mockResolvedValue(groups);

  const response = await GET(
    new Request("http://localhost/api/internal/labels?projectId=project-a&value=Needs+review"),
  );

  expect(mocks.groupBy).toHaveBeenCalledWith({
    by: ["traceId"],
    where: { projectId: "project-a", value: "Needs review", traceId: {} },
    orderBy: { traceId: "asc" },
    take: 501,
  });
  expect(await response.json()).toEqual({
    traceIds: groups.slice(0, 500).map(({ traceId }) => traceId),
    overflow: true,
  });
});

it("applies requested IDs and the next-page cursor before limiting the lookup", async () => {
  mocks.groupBy.mockResolvedValue([{ traceId: "trace-b" }]);
  const url = new URL("http://localhost/api/internal/labels");
  url.searchParams.set("projectId", "project-a");
  url.searchParams.set("value", "Needs review");
  url.searchParams.set("afterTraceId", "trace-a");
  url.searchParams.append("traceId", "trace-a");
  url.searchParams.append("traceId", "trace-b");
  const response = await GET(new Request(url));

  expect(mocks.groupBy).toHaveBeenCalledExactlyOnceWith({
    by: ["traceId"],
    where: {
      projectId: "project-a",
      value: "Needs review",
      traceId: { in: ["trace-a", "trace-b"], gt: "trace-a" },
    },
    orderBy: { traceId: "asc" },
    take: 501,
  });
  expect(await response.json()).toEqual({ traceIds: ["trace-b"], overflow: false });
});
