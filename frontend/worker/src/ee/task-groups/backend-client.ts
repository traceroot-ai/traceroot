/**
 * The worker's side of the task-group endpoints. The Python backend runs the
 * ClickHouse queries; the worker never connects to ClickHouse itself.
 */

import { BACKEND_TIMEOUT_MS } from "./config.js";

export interface CandidateRow {
  traceId: string;
  traceTimeMs: number;
  /** Decimal string of the backend's sampling key. */
  key: string;
}

export interface DigestWrite {
  traceId: string;
  traceTimeMs: number;
  summary: string;
  embedding: number[];
  summaryModel: string;
  embeddingModel: string;
  digestVersion: number;
  costUsd: number;
}

export interface GroupForPlacement {
  groupId: string;
  name: string;
  center: number[];
  reach: number;
  size: number;
}

export interface UnplacedRow {
  traceId: string;
  traceTimeMs: number;
  embedding: number[];
}

export interface MemberWrite {
  traceId: string;
  traceTimeMs: number;
  groupId: string;
  distance: number;
}

export interface TaskGroupBackend {
  candidates(params: {
    projectId: string;
    sinceMs: number;
    untilMs: number;
    idleBeforeMs: number;
    limit: number;
  }): Promise<{ rows: CandidateRow[]; digested: number }>;
  spansJsonl(projectId: string, traceId: string): Promise<string>;
  writeDigests(projectId: string, rows: DigestWrite[]): Promise<void>;
  currentGroups(projectId: string): Promise<{ fitId: string | null; groups: GroupForPlacement[] }>;
  unplaced(projectId: string, fitId: string, limit: number): Promise<UnplacedRow[]>;
  writeMembers(
    projectId: string,
    fitId: string,
    source: "assigned" | "fit",
    rows: MemberWrite[],
  ): Promise<void>;
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  opts: { params?: Record<string, string>; body?: unknown; text?: boolean } = {},
): Promise<T> {
  const url = new URL(path, process.env.BACKEND_INTERNAL_URL || "http://localhost:8000");
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(
        `task-group backend ${method} ${path} returned ${response.status}: ${detail}`,
      );
    }
    return (opts.text ? await response.text() : await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const BASE = "/api/v1/internal/task-groups";

export const taskGroupBackend: TaskGroupBackend = {
  async candidates(p) {
    const res = await call<{
      data: { trace_id: string; trace_time_ms: number; key: string }[];
      digested: number;
    }>("GET", `${BASE}/candidates`, {
      params: {
        project_id: p.projectId,
        since_ms: String(p.sinceMs),
        until_ms: String(p.untilMs),
        idle_before_ms: String(p.idleBeforeMs),
        limit: String(p.limit),
      },
    });
    return {
      digested: res.digested,
      rows: res.data.map((r) => ({
        traceId: r.trace_id,
        traceTimeMs: r.trace_time_ms,
        key: r.key,
      })),
    };
  },

  spansJsonl: (projectId, traceId) =>
    call<string>("GET", `/api/v1/internal/traces/${encodeURIComponent(traceId)}/spans-jsonl`, {
      params: { project_id: projectId },
      text: true,
    }),

  async writeDigests(projectId, rows) {
    await call("POST", `${BASE}/digests`, {
      body: {
        project_id: projectId,
        rows: rows.map((r) => ({
          trace_id: r.traceId,
          trace_time_ms: r.traceTimeMs,
          summary: r.summary,
          embedding: r.embedding,
          summary_model: r.summaryModel,
          embedding_model: r.embeddingModel,
          digest_version: r.digestVersion,
          cost_usd: r.costUsd,
        })),
      },
    });
  },

  async currentGroups(projectId) {
    const res = await call<{
      fit_id: string | null;
      data: { group_id: string; name: string; center: number[]; reach: number; size: number }[];
    }>("GET", `${BASE}/current-groups`, { params: { project_id: projectId } });
    return {
      fitId: res.fit_id,
      groups: res.data.map((g) => ({
        groupId: g.group_id,
        name: g.name,
        center: g.center,
        reach: g.reach,
        size: g.size,
      })),
    };
  },

  async unplaced(projectId, fitId, limit) {
    const res = await call<{
      data: { trace_id: string; trace_time_ms: number; embedding: number[] }[];
    }>("GET", `${BASE}/unplaced`, {
      params: { project_id: projectId, fit_id: fitId, limit: String(limit) },
    });
    return res.data.map((r) => ({
      traceId: r.trace_id,
      traceTimeMs: r.trace_time_ms,
      embedding: r.embedding,
    }));
  },

  async writeMembers(projectId, fitId, source, rows) {
    await call("POST", `${BASE}/members`, {
      body: {
        project_id: projectId,
        fit_id: fitId,
        source,
        rows: rows.map((r) => ({
          trace_id: r.traceId,
          trace_time_ms: r.traceTimeMs,
          group_id: r.groupId,
          distance: r.distance,
        })),
      },
    });
  },
};
