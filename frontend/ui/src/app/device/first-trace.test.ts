import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
}));

vi.mock("@/lib/api/projects", () => ({
  getProjects: (workspaceId: string) => mocks.getProjects(workspaceId),
}));

import { MAX_WATCHED_PROJECTS, readWatchedProjects, watchOrder } from "./first-trace";
import type { BaselineEntry } from "@/lib/first-trace";
import type { Project, Workspace } from "@/types/api";

function workspace(id: string): Workspace {
  return { id, name: id, role: "ADMIN", create_time: "2026-01-01T00:00:00Z" };
}

function project(id: string, createTime: string): Project {
  return { id, name: id, trace_ttl_days: null, create_time: createTime };
}

afterEach(() => {
  mocks.getProjects.mockReset();
});

describe("readWatchedProjects", () => {
  it("gathers projects across every workspace, newest created first", async () => {
    mocks.getProjects.mockImplementation(async (workspaceId: string) =>
      workspaceId === "ws-1"
        ? [project("old", "2026-01-01T00:00:00Z")]
        : [project("new", "2026-03-01T00:00:00Z")],
    );

    const { projects, complete } = await readWatchedProjects([
      workspace("ws-1"),
      workspace("ws-2"),
    ]);

    expect(projects.map((p) => p.id)).toEqual(["new", "old"]);
    expect(complete).toBe(true);
  });

  it("skips a workspace it cannot list rather than losing the others", async () => {
    // One unreadable workspace must not blind the tab to a trace landing in
    // another — the wait is additive, so a partial read still beats no read.
    mocks.getProjects.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === "ws-1") throw new Error("boom");
      return [project("p-2", "2026-01-01T00:00:00Z")];
    });

    const { projects, complete } = await readWatchedProjects([
      workspace("ws-1"),
      workspace("ws-2"),
    ]);

    expect(projects.map((p) => p.id)).toEqual(["p-2"]);
    // Reported, though: a project turning up in a later round may be one this
    // listing could not see rather than one the terminal has just made.
    expect(complete).toBe(false);
  });

  it("caps how many projects one round will look in, keeping the newest", async () => {
    // The cap is pinned here and the fixture is a fixed size, because a fixture
    // sized from the constant and compared back to it passes for any cap at
    // all — including one, and including none.
    expect(MAX_WATCHED_PROJECTS).toBe(3);
    const many = Array.from({ length: 8 }, (_, i) =>
      project(`p-${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    mocks.getProjects.mockResolvedValue(many);

    const { projects, complete } = await readWatchedProjects([workspace("ws-1")]);

    // Which three, in which order: the cap, its direction and the sort at once.
    expect(projects.map((p) => p.id)).toEqual(["p-7", "p-6", "p-5"]);
    // The cap hides projects too, and one of them can enter the window later —
    // when a watched project is deleted — so a capped listing is not the whole
    // account either.
    expect(complete).toBe(false);
  });
});

describe("watchOrder", () => {
  it("puts a project created after approval ahead of one that already existed", () => {
    // A project the terminal made is the closest thing to a binding this page
    // has: nothing the SDK sends carries the device code, but a project that
    // did not exist at approval belongs to the run that just authorized.
    const order = watchOrder(
      [project("p-known", "2026-01-01T00:00:00Z"), project("p-fresh", "2026-05-01T10:59:00Z")],
      new Map<string, BaselineEntry>([["p-known", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]),
    );

    expect(order).toEqual(["p-fresh", "p-known"]);
  });

  it("keeps the projects that already existed, after the new one and in their own order", () => {
    // The ordering is a preference, not a filter: an established account whose
    // terminal reused a project it already had still has to be able to match.
    // Three projects with the new one in the middle, so the answer is not the
    // list as supplied and a passthrough cannot satisfy it.
    const order = watchOrder(
      [
        project("p-known-1", "2026-01-01T00:00:00Z"),
        project("p-fresh", "2026-05-01T10:59:00Z"),
        project("p-known-2", "2026-02-01T00:00:00Z"),
      ],
      new Map<string, BaselineEntry>([
        ["p-known-1", { kind: "empty" }],
        ["p-known-2", { kind: "newest", at: "2026-05-01T10:00:00Z" }],
      ]),
    );

    expect(order).toEqual(["p-fresh", "p-known-1", "p-known-2"]);
  });
});
