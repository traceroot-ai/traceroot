import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
}));

vi.mock("@/lib/api/projects", () => ({
  getProjects: (workspaceId: string) => mocks.getProjects(workspaceId),
}));

import {
  MAX_KEYED_PROJECTS,
  MAX_WATCHED_PROJECTS,
  readWatchedProjects,
  watchOrder,
} from "./first-trace";
import type { BaselineEntry } from "@/lib/first-trace";
import type { Project, Workspace } from "@/types/api";

function workspace(id: string): Workspace {
  return { id, name: id, role: "ADMIN", create_time: "2026-01-01T00:00:00Z" };
}

function project(id: string, createTime: string, accessKeyCount?: number): Project {
  return {
    id,
    name: id,
    trace_ttl_days: null,
    create_time: createTime,
    ...(accessKeyCount === undefined ? {} : { access_key_count: accessKeyCount }),
  };
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

  /** Five projects, newest first, each holding one key unless `keys` says otherwise. */
  function account(keys: Record<string, number> = {}): Project[] {
    return ["p-5", "p-4", "p-3", "p-2", "p-1"].map((id, i) =>
      project(id, `2026-0${5 - i}-01T00:00:00Z`, keys[id] ?? 1),
    );
  }

  it("watches an older project once the terminal mints a key in it", async () => {
    // The device flow never names the project the terminal chose. Its keys do:
    // they are minted in that project right after approval, and the listing
    // this round already reads counts them.
    mocks.getProjects.mockResolvedValue(account());
    const first = await readWatchedProjects([workspace("ws-1")]);
    expect(first.projects.map((p) => p.id)).toEqual(["p-5", "p-4", "p-3"]);

    mocks.getProjects.mockResolvedValue(account({ "p-1": 3 }));
    const next = await readWatchedProjects([workspace("ws-1")], first.keyCounts);

    expect(next.projects.map((p) => p.id)).toEqual(["p-5", "p-4", "p-3", "p-1"]);
  });

  it("keeps watching it in later rounds, against the count it first saw", async () => {
    mocks.getProjects.mockResolvedValue(account());
    const first = await readWatchedProjects([workspace("ws-1")]);
    mocks.getProjects.mockResolvedValue(account({ "p-1": 3 }));
    const second = await readWatchedProjects([workspace("ws-1")], first.keyCounts);

    const third = await readWatchedProjects([workspace("ws-1")], second.keyCounts);

    expect(third.projects.map((p) => p.id)).toEqual(["p-5", "p-4", "p-3", "p-1"]);
    expect(third.keyCounts.get("p-1")).toBe(1);
  });

  it("watches only the newest while no older project gains a key", async () => {
    mocks.getProjects.mockResolvedValue(account());
    const first = await readWatchedProjects([workspace("ws-1")]);

    const next = await readWatchedProjects([workspace("ws-1")], first.keyCounts);

    expect(next.projects.map((p) => p.id)).toEqual(["p-5", "p-4", "p-3"]);
  });

  it("does not add a project twice when the one that gained a key is already watched", async () => {
    // The common case: the terminal chose one of the newest projects. Nothing
    // about the watch changes, not even its order.
    mocks.getProjects.mockResolvedValue(account());
    const first = await readWatchedProjects([workspace("ws-1")]);
    mocks.getProjects.mockResolvedValue(account({ "p-4": 3 }));

    const next = await readWatchedProjects([workspace("ws-1")], first.keyCounts);

    expect(next.projects.map((p) => p.id)).toEqual(["p-5", "p-4", "p-3"]);
  });

  it("reads the keys a project already had on first sight as its starting count", async () => {
    mocks.getProjects.mockResolvedValue(account({ "p-1": 4 }));

    const first = await readWatchedProjects([workspace("ws-1")]);

    expect(first.projects.map((p) => p.id)).toEqual(["p-5", "p-4", "p-3"]);
    expect(first.keyCounts.get("p-1")).toBe(4);
  });

  it("adds nothing on a listing that does not count keys", async () => {
    const uncounted = ["p-5", "p-4", "p-3", "p-1"].map((id, i) =>
      project(id, `2026-0${5 - i}-01T00:00:00Z`),
    );
    mocks.getProjects.mockResolvedValue(uncounted);
    const first = await readWatchedProjects([workspace("ws-1")]);

    const next = await readWatchedProjects([workspace("ws-1")], first.keyCounts);

    expect(next.projects.map((p) => p.id)).toEqual(["p-5", "p-4", "p-3"]);
  });

  it("caps how many projects it adds on key evidence, keeping the newest", async () => {
    const older = MAX_KEYED_PROJECTS + 2;
    const many = (keys: number) =>
      Array.from({ length: MAX_WATCHED_PROJECTS + older }, (_, i) =>
        project(`p-${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, keys),
      );
    mocks.getProjects.mockResolvedValue(many(1));
    const first = await readWatchedProjects([workspace("ws-1")]);
    mocks.getProjects.mockResolvedValue(many(2));

    const next = await readWatchedProjects([workspace("ws-1")], first.keyCounts);

    expect(next.projects).toHaveLength(MAX_WATCHED_PROJECTS + MAX_KEYED_PROJECTS);
    expect(next.projects[MAX_WATCHED_PROJECTS].id).toBe(`p-${older - 1}`);
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
