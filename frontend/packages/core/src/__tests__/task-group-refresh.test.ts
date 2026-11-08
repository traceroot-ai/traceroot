import { describe, expect, it, vi } from "vitest";
import { REFRESH_MIN_INTERVAL_MS, requestTaskGroupRefresh } from "../ee/task-groups/refresh.ts";

const now = new Date("2026-11-08T12:00:00Z");

function db(...results: unknown[][]) {
  const queryRaw = vi.fn();
  for (const r of results) queryRaw.mockResolvedValueOnce(r);
  return { $queryRaw: queryRaw } as never;
}

describe("requestTaskGroupRefresh", () => {
  it("accepts when the statement updated a row", async () => {
    const res = await requestTaskGroupRefresh(db([{ refresh_requested_at: now }]), "p", now);
    expect(res).toEqual({ accepted: true, nextAllowedAt: null });
  });

  it("refuses within the hour and says when the next request is taken", async () => {
    const last = new Date(now.getTime() - 10 * 60_000);
    const res = await requestTaskGroupRefresh(db([], [{ refresh_requested_at: last }]), "p", now);
    expect(res.accepted).toBe(false);
    expect(res.nextAllowedAt?.getTime()).toBe(last.getTime() + REFRESH_MIN_INTERVAL_MS);
  });

  it("refuses without a date when the project has the feature off", async () => {
    const res = await requestTaskGroupRefresh(db([], []), "p", now);
    expect(res).toEqual({ accepted: false, nextAllowedAt: null });
  });
});
