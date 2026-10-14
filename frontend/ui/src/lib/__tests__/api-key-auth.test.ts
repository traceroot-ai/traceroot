/**
 * Both API-key surfaces resolve their caller through one function
 * (`resolveApiKeyProject`) and then map the outcome onto their own wire
 * contract. These tests pin the three things that matter:
 *
 * 1. Acceptance: which keys are refused, and for which reason.
 * 2. That the Bearer public API keeps answering `{detail}` — flat 401s that
 *    never say *why*, and 403 for a scope refusal.
 * 3. That the SDK reporting surface keeps answering the `{error}` bodies its
 *    shipped clients already parse, including the "API key expired" wording the
 *    Bearer surface deliberately collapses away.
 *
 * (3) is the regression guard: unifying the lookup must not change the
 * reporting routes' responses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashApiKey } from "@/lib/api-keys";

const prismaMock = vi.hoisted(() => ({
  accessKey: { findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock("@traceroot/core", () => ({ prisma: prismaMock }));

import { requireApiKeyProject, resolveApiKeyProject, parseScope } from "@/lib/public-auth";
import { requireEvalApiKeyProject } from "@/lib/eval/auth";

const KEY = "tr-11111111-2222-3333-4444-555555555555";

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    scope: "ingest",
    expireTime: null,
    project: {
      id: "proj-1",
      name: "Proj",
      deleteTime: null,
      workspace: { id: "ws-1" },
    },
    ...overrides,
  };
}

function req(authorization?: string): Request {
  return new Request("http://localhost/api/public/datasets", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

beforeEach(() => {
  prismaMock.accessKey.findUnique.mockReset();
  prismaMock.accessKey.update.mockReset();
  prismaMock.accessKey.findUnique.mockResolvedValue(keyRow());
  prismaMock.accessKey.update.mockResolvedValue({});
});

describe("resolveApiKeyProject", () => {
  it("resolves the project and scope for a valid key", async () => {
    const result = await resolveApiKeyProject(req(`Bearer ${KEY}`));
    expect(result).toEqual({
      ok: true,
      auth: {
        projectId: "proj-1",
        projectName: "Proj",
        workspaceId: "ws-1",
        keyId: "key-1",
        scope: "ingest",
      },
    });
  });

  it("looks the key up by its hash, never by the key itself", async () => {
    await resolveApiKeyProject(req(`Bearer ${KEY}`));
    expect(prismaMock.accessKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { secretHash: hashApiKey(KEY) } }),
    );
  });

  it.each([
    ["no header", undefined],
    ["a non-Bearer header", "Basic abc"],
    ["an empty Bearer token", "Bearer    "],
  ])("reports missing_token for %s", async (_label, header) => {
    expect(await resolveApiKeyProject(req(header))).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });

  it("reports not_found for an unknown key", async () => {
    prismaMock.accessKey.findUnique.mockResolvedValue(null);
    expect(await resolveApiKeyProject(req(`Bearer ${KEY}`))).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("reports project_deleted for a key on a deleted project", async () => {
    prismaMock.accessKey.findUnique.mockResolvedValue(
      keyRow({ project: { ...keyRow().project, deleteTime: new Date("2020-01-01") } }),
    );
    expect(await resolveApiKeyProject(req(`Bearer ${KEY}`))).toEqual({
      ok: false,
      reason: "project_deleted",
    });
  });

  it("reports expired for a key past its expiry", async () => {
    prismaMock.accessKey.findUnique.mockResolvedValue(
      keyRow({ expireTime: new Date("2020-01-01") }),
    );
    expect(await resolveApiKeyProject(req(`Bearer ${KEY}`))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("reports insufficient_scope when admin is required and the key is ingest", async () => {
    expect(await resolveApiKeyProject(req(`Bearer ${KEY}`), { require: "admin" })).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
  });

  it("admits an admin key where admin is required", async () => {
    prismaMock.accessKey.findUnique.mockResolvedValue(keyRow({ scope: "admin" }));
    const result = await resolveApiKeyProject(req(`Bearer ${KEY}`), { require: "admin" });
    expect(result.ok).toBe(true);
  });

  it("stamps lastUseTime for a genuine key, including one refused for scope", async () => {
    await resolveApiKeyProject(req(`Bearer ${KEY}`), { require: "admin" });
    expect(prismaMock.accessKey.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "key-1" } }),
    );
  });

  it("does not stamp lastUseTime for a key that never authenticated", async () => {
    prismaMock.accessKey.findUnique.mockResolvedValue(null);
    await resolveApiKeyProject(req(`Bearer ${KEY}`));
    expect(prismaMock.accessKey.update).not.toHaveBeenCalled();
  });

  it("admits the request when the advisory lastUseTime write fails", async () => {
    prismaMock.accessKey.update.mockRejectedValue(new Error("db down"));
    const result = await resolveApiKeyProject(req(`Bearer ${KEY}`));
    expect(result.ok).toBe(true);
  });

  it("fails an unrecognised stored scope closed to ingest", () => {
    expect(parseScope("superuser")).toBe("ingest");
    expect(parseScope(undefined)).toBe("ingest");
    expect(parseScope("admin")).toBe("admin");
  });
});

describe("requireApiKeyProject (Bearer public API)", () => {
  it("answers a flat 401 {detail} that does not distinguish the reason", async () => {
    const bodies: unknown[] = [];
    for (const row of [null, keyRow({ expireTime: new Date("2020-01-01") })]) {
      prismaMock.accessKey.findUnique.mockResolvedValue(row);
      const result = await requireApiKeyProject(req(`Bearer ${KEY}`));
      if (result.ok) throw new Error("expected a refusal");
      expect(result.response.status).toBe(401);
      bodies.push(await result.response.json());
    }
    expect(bodies[0]).toEqual({ detail: "Invalid API key" });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("answers 401 {detail} for a missing Authorization header", async () => {
    const result = await requireApiKeyProject(req());
    if (result.ok) throw new Error("expected a refusal");
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({
      detail: "Missing or malformed Authorization header",
    });
  });

  it("answers 403 {detail} when an ingest key is used where admin is required", async () => {
    const result = await requireApiKeyProject(req(`Bearer ${KEY}`), { require: "admin" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({
      detail: "This API key is scoped to telemetry ingestion and cannot manage project settings.",
    });
  });
});

describe("requireEvalApiKeyProject (SDK reporting surface)", () => {
  it("returns the project id for a valid key of either scope", async () => {
    for (const scope of ["ingest", "admin"]) {
      prismaMock.accessKey.findUnique.mockResolvedValue(keyRow({ scope }));
      expect(await requireEvalApiKeyProject(req(`Bearer ${KEY}`))).toEqual({
        projectId: "proj-1",
      });
    }
  });

  it.each([
    ["Missing bearer API key", 401, undefined, () => null as unknown],
    ["Invalid API key", 401, `Bearer ${KEY}`, () => null as unknown],
    ["API key expired", 401, `Bearer ${KEY}`, () => keyRow({ expireTime: new Date("2020-01-01") })],
    [
      "Invalid API key",
      401,
      `Bearer ${KEY}`,
      () => keyRow({ project: { ...keyRow().project, deleteTime: new Date("2020-01-01") } }),
    ],
  ])("keeps answering its own %s body", async (message, status, header, row) => {
    prismaMock.accessKey.findUnique.mockResolvedValue(row());
    const result = await requireEvalApiKeyProject(req(header));
    if (!result.error) throw new Error("expected a refusal");
    expect(result.error.status).toBe(status);
    expect(await result.error.json()).toEqual({ error: message });
  });

  it("answers 403 {error} if a route ever asks for a scope the key lacks", async () => {
    const result = await requireEvalApiKeyProject(req(`Bearer ${KEY}`), { require: "admin" });
    if (!result.error) throw new Error("expected a refusal");
    expect(result.error.status).toBe(403);
    expect(await result.error.json()).toEqual({
      error: "This API key is scoped to telemetry ingestion and cannot perform this write.",
    });
  });
});
