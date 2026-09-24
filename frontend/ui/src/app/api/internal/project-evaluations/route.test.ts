import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

// The reads themselves — project scoping, retention, the body — are pinned beside
// `readRunSummary` and the dataset reads. This suite pins what the route adds: the secret,
// validation, and that each read's answer reaches the backend unchanged.
const readRunSummaryMock = vi.fn();
vi.mock("@/lib/eval/run-read", () => ({
  readRunSummary: (...args: unknown[]) => readRunSummaryMock(...args),
}));

const datasetReads = vi.hoisted(() => ({
  listDatasetsPage: vi.fn(),
  getDatasetDetail: vi.fn(),
  listDatasetVersionsPage: vi.fn(),
  getDatasetVersionPage: vi.fn(),
}));
vi.mock("@/lib/eval/dataset-read", () => datasetReads);

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const SUMMARY = { evaluation_run_id: "run-1", scores: [], metrics: [] };

beforeEach(() => {
  readRunSummaryMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
  readRunSummaryMock.mockResolvedValue({ ok: true, body: SUMMARY });
  for (const fn of Object.values(datasetReads)) {
    fn.mockReset();
    fn.mockResolvedValue({ ok: true, body: { ok: "dataset-read" } });
  }
});

describe("POST /api/internal/project-evaluations", () => {
  it("rejects an unauthorized caller before reading anything", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ read: "run", projectId: "proj-1", runId: "run-1" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(readRunSummaryMock).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with a 400", async () => {
    const req = {
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it.each([
    [{ read: "run", runId: "run-1" }, "projectId is required"],
    [{ read: "run", projectId: "", runId: "run-1" }, "projectId is required"],
    [{ read: "run", projectId: "proj-1" }, "runId is required"],
    [{ read: "run", projectId: "proj-1", runId: 7 }, "runId is required"],
  ])("rejects %j with a fixed message", async (body, message) => {
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
    expect(readRunSummaryMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown read before reading anything", async () => {
    const res = await POST(makeRequest({ read: "everything", projectId: "proj-1" }));

    expect(res.status).toBe(400);
    expect(readRunSummaryMock).not.toHaveBeenCalled();
  });

  it("reads the run inside the given project", async () => {
    const res = await POST(makeRequest({ read: "run", projectId: "proj-1", runId: "run-1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUMMARY);
    expect(readRunSummaryMock).toHaveBeenCalledWith({ projectId: "proj-1", runId: "run-1" });
  });

  it("drops a field the read does not take rather than passing it on", async () => {
    await POST(
      makeRequest({ read: "run", projectId: "proj-1", runId: "run-1", baselineRunId: "run-0" }),
    );

    expect(readRunSummaryMock).toHaveBeenCalledWith({ projectId: "proj-1", runId: "run-1" });
  });

  it.each([
    [404, "Evaluation run not found"],
    [403, "Data outside retention window"],
  ])("answers a refused read with %i and its message", async (status, error) => {
    readRunSummaryMock.mockResolvedValue({ ok: false, status, error });

    const res = await POST(makeRequest({ read: "run", projectId: "proj-1", runId: "run-1" }));

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  describe("dataset reads", () => {
    it("lists datasets with the page, cursor and name passed through", async () => {
      const res = await POST(
        makeRequest({
          read: "datasets",
          projectId: "proj-1",
          limit: 5,
          cursor: "c1",
          name: "refunds",
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: "dataset-read" });
      expect(datasetReads.listDatasetsPage).toHaveBeenCalledWith({
        projectId: "proj-1",
        limit: 5,
        cursor: "c1",
        name: "refunds",
      });
    });

    it("lists datasets with every optional parameter left to the read's defaults", async () => {
      await POST(makeRequest({ read: "datasets", projectId: "proj-1" }));

      expect(datasetReads.listDatasetsPage).toHaveBeenCalledWith({
        projectId: "proj-1",
        limit: undefined,
        cursor: null,
        name: null,
      });
    });

    it("reads one dataset inside the given project", async () => {
      await POST(makeRequest({ read: "dataset", projectId: "proj-1", datasetId: "ds_1" }));

      expect(datasetReads.getDatasetDetail).toHaveBeenCalledWith({
        projectId: "proj-1",
        datasetId: "ds_1",
      });
    });

    it("lists a dataset's versions with the page and cursor passed through", async () => {
      await POST(
        makeRequest({
          read: "dataset_versions",
          projectId: "proj-1",
          datasetId: "ds_1",
          cursor: "c2",
        }),
      );

      expect(datasetReads.listDatasetVersionsPage).toHaveBeenCalledWith({
        projectId: "proj-1",
        datasetId: "ds_1",
        limit: undefined,
        cursor: "c2",
      });
    });

    it("reads one version's page of cases", async () => {
      await POST(
        makeRequest({ read: "dataset_version", projectId: "proj-1", versionId: "dv_1", limit: 20 }),
      );

      expect(datasetReads.getDatasetVersionPage).toHaveBeenCalledWith({
        projectId: "proj-1",
        versionId: "dv_1",
        limit: 20,
        cursor: null,
      });
    });

    it.each([
      [{ read: "dataset", projectId: "proj-1" }, "datasetId is required"],
      [{ read: "dataset_versions", projectId: "proj-1", datasetId: "" }, "datasetId is required"],
      [{ read: "dataset_version", projectId: "proj-1" }, "versionId is required"],
      [{ read: "datasets" }, "projectId is required"],
      [{ read: "datasets", projectId: "proj-1", limit: "5" }, "limit must be a number"],
      [{ read: "datasets", projectId: "proj-1", limit: 2.5 }, "limit must be an integer"],
      [{ read: "datasets", projectId: "proj-1", cursor: "" }, "cursor must be a string"],
    ])("rejects %j with a fixed message", async (body, message) => {
      const res = await POST(makeRequest(body));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message });
      for (const fn of Object.values(datasetReads)) expect(fn).not.toHaveBeenCalled();
    });

    it.each([
      ["dataset", { datasetId: "gone" }, "Dataset not found"],
      ["dataset_versions", { datasetId: "gone" }, "Dataset not found"],
      ["dataset_version", { versionId: "gone" }, "Dataset version not found"],
    ])("answers a missing %s with 404 and its message", async (read, ids, error) => {
      for (const fn of Object.values(datasetReads)) {
        fn.mockResolvedValue({ ok: false, status: 404, error });
      }

      const res = await POST(makeRequest({ read, projectId: "proj-1", ...ids }));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error });
    });
  });
});
