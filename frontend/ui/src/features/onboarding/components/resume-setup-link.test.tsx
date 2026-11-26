// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ACTIVITY_REFRESH_INTERVAL_MS } from "@/features/workspaces/hooks";
import { forgetSetup, rememberSetup, setupResumeKey } from "../setup-resume";
import { ResumeSetupLink } from "./resume-setup-link";

function workspaceList(userId: string) {
  const client = new QueryClient();
  const list = (userId: string) => (
    <QueryClientProvider client={client}>
      <ResumeSetupLink userId={userId} />
    </QueryClientProvider>
  );
  const { rerender } = render(list(userId));
  return { client, switchAccount: (id: string) => rerender(list(id)) };
}

const resumeLink = () => screen.queryByRole("link", { name: "Resume setup" });
const traceStatus = (firstTrace: string | null) =>
  Response.json({ first_trace_receive_time: firstTrace });

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resuming setup from the workspace list", () => {
  it("does no request when the account never interrupted setup", () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    workspaceList("new-user");
    expect(request).not.toHaveBeenCalled();
    expect(resumeLink()).toBeNull();
  });

  it("resumes the last project visited by this account, after checking its current status", async () => {
    rememberSetup("alice", "earlier", "workspace");
    rememberSetup("alice", "active", "project");
    forgetSetup("alice", "earlier");
    let answer!: (result: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", request);
    const { switchAccount } = workspaceList("alice");
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]).toEqual(["/api/projects/active/first-trace", expect.anything()]);
    expect(resumeLink()).toBeNull();
    await act(async () => answer(traceStatus(null)));
    expect((await screen.findByRole("link")).getAttribute("href")).toBe(
      "/onboarding/setup?projectId=active&created=project",
    );
    switchAccount("bob");
    expect(resumeLink()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("removes the link when another teammate sends the first trace", async () => {
    rememberSetup("alice", "active", "workspace");
    const request = vi
      .fn()
      .mockResolvedValueOnce(traceStatus(null))
      .mockResolvedValueOnce(traceStatus("2026-11-26T10:00:00Z"));
    vi.stubGlobal("fetch", request);
    const { client } = workspaceList("alice");
    expect((await screen.findByRole("link")).getAttribute("href")).toBe(
      "/onboarding/setup?projectId=active",
    );
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(resumeLink()).toBeNull());
    expect(JSON.parse(localStorage.getItem(setupResumeKey("alice"))!)).toEqual([]);
  });

  it("falls back to another unfinished project after the last one completes", async () => {
    rememberSetup("alice", "previous", "workspace");
    rememberSetup("alice", "latest", "project");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(traceStatus("2026-11-26T10:00:00Z"))
        .mockResolvedValueOnce(traceStatus(null)),
    );
    workspaceList("alice");
    expect((await screen.findByRole("link")).getAttribute("href")).toBe(
      "/onboarding/setup?projectId=previous",
    );
  });

  it("recovers on the open workspace list after a temporary first-trace outage", async () => {
    vi.useFakeTimers();
    rememberSetup("alice", "active", "project");
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 502 }))
      .mockResolvedValueOnce(traceStatus(null));
    vi.stubGlobal("fetch", request);
    workspaceList("alice");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(resumeLink()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_INTERVAL_MS + 5);
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(resumeLink()?.getAttribute("href")).toBe(
      "/onboarding/setup?projectId=active&created=project",
    );
  });

  it.each([403, 404, 502])("hides an inaccessible or unverified project (%i)", async (status) => {
    rememberSetup("alice", "hidden", "workspace");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status })));
    const { client } = workspaceList("alice");
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(resumeLink()).toBeNull();
  });
});
