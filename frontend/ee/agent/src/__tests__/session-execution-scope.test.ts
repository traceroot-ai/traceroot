import { describe, expect, it, vi } from "vitest";

import { executionBelongsToProject } from "../session.js";

/**
 * A session's executionId becomes the attribution on every message in it, so
 * accepting one the caller merely names would let a turn in project A be
 * attributed to an execution in project B. The route rejects an id that does
 * not resolve under the project it is creating the session in.
 */
describe("executionBelongsToProject", () => {
  const db = (result: { id: string } | null) => {
    const findFirst = vi.fn(async () => result);
    return { db: { detectorRcaExecution: { findFirst } }, findFirst };
  };

  it("accepts an execution that exists under the project", async () => {
    const { db: prisma, findFirst } = db({ id: "e1" });
    expect(await executionBelongsToProject(prisma, "e1", "p1")).toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "e1", projectId: "p1" } }),
    );
  });

  it("rejects an execution belonging to another project", async () => {
    const { db: prisma } = db(null);
    expect(await executionBelongsToProject(prisma, "e-from-p2", "p1")).toBe(false);
  });

  it("rejects an id that does not exist at all", async () => {
    const { db: prisma } = db(null);
    expect(await executionBelongsToProject(prisma, "nonsense", "p1")).toBe(false);
  });
});
