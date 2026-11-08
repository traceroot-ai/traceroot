// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  data: {
    configured: true,
    enabled: true,
    frequency: "weekly",
    weekday: 1,
    hour: 9,
    timezone: "Europe/Berlin",
    next_slot_at: "2026-11-09T08:00:00.000Z",
    run_token_cap: 200000,
    monthly_spend_cap_usd: 20,
    code_changes_enabled: false,
    code_repos: [],
    last_run: {
      id: "r1",
      status: "succeeded",
      trigger: "scheduled",
      slot_at: "2026-11-02T08:00:00.000Z",
      finished_at: "2026-11-02T08:01:00.000Z",
      error: null,
      stop_reason: null,
      delivery_note: "Email skipped: no mail transport is configured (set TRACEROOT_SMTP_URL).",
      skills_ran: ["update-self-check", "update-macro-shifts"],
      tokens: 25565,
      cost_usd: 0.0666,
      slack_delivered: true,
      email_delivered: false,
    },
  } as unknown as Record<string, unknown>,
  mutate: vi.fn(),
  saveState: { isPending: false, isError: false, isSuccess: false, error: null as Error | null },
}));

vi.mock("../hooks/useUpdateSchedule", () => ({
  useUpdateSchedule: () => ({ data: mocks.data, isLoading: false, isError: false }),
  useSaveUpdateSchedule: () => ({ mutate: mocks.mutate, ...mocks.saveState }),
}));

import { UpdatesTab } from "./UpdatesTab";

afterEach(() => {
  cleanup();
  mocks.mutate.mockReset();
  mocks.saveState.isError = false;
  mocks.saveState.error = null;
});

describe("UpdatesTab", () => {
  it("lists all seventeen skills read-only, marks the three that are always on, and shows which ran", () => {
    render(<UpdatesTab projectId="p1" />);
    const list = screen.getByRole("list", { name: "Update skills" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(17);
    expect(within(list).getAllByText("Always on")).toHaveLength(3);
    expect(within(list).getAllByText("Ran in the last update")).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: /skill/i })).toBeNull();
  });

  it("shows a skill's text when it is opened", () => {
    render(<UpdatesTab projectId="p1" />);
    expect(screen.queryByText(/Before you call submit_update, check your own work/)).toBeNull();
    fireEvent.click(screen.getByText("update-self-check"));
    expect(screen.getByText(/Before you call submit_update, check your own work/)).toBeTruthy();
  });

  it("shows the last update's status, delivery and what was skipped", () => {
    render(<UpdatesTab projectId="p1" />);
    expect(screen.getByText("succeeded")).toBeTruthy();
    expect(screen.getByText(/Email skipped/)).toBeTruthy();
    expect(screen.getByText(/Sent to Slack/)).toBeTruthy();
  });

  it("offers daily, weekly and custom, and nothing more frequent than daily", () => {
    render(<UpdatesTab projectId="p1" />);
    const options = within(screen.getByLabelText("Frequency"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Daily", "Weekly (Monday 09:00)", "Custom"]);
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "custom" } });
    const repeats = within(screen.getByLabelText("Repeats"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(repeats).toEqual(["Every day", "Every week"]);
  });

  it("saves a custom day, hour and timezone", () => {
    render(<UpdatesTab projectId="p1" />);
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Hour"), { target: { value: "17" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "America/New_York" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      enabled: true,
      frequency: "weekly",
      weekday: 5,
      hour: 17,
      timezone: "America/New_York",
      runTokenCap: 200000,
      monthlySpendCapUsd: 20,
      codeChangesEnabled: false,
      codeRepos: [],
    });
  });

  it("choosing Daily sets the daily preset", () => {
    render(<UpdatesTab projectId="p1" />);
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "daily" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ frequency: "daily", hour: 9 }),
    );
  });

  it("keeps code changes off until switched on, and saves the repositories listed", () => {
    render(<UpdatesTab projectId="p1" />);
    const box = screen.getByLabelText("Repositories") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Off" }));
    fireEvent.change(box, { target: { value: "acme/web-app\n\nAcme/Web-App\nacme/api" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        codeChangesEnabled: true,
        codeRepos: ["acme/web-app", "acme/api"],
      }),
    );
  });

  it("shows the reason when the API refuses a schedule", () => {
    mocks.saveState.isError = true;
    mocks.saveState.error = new Error("Updates run at most once a day.");
    render(<UpdatesTab projectId="p1" />);
    expect(screen.getByRole("alert").textContent).toContain("at most once a day");
  });
});
