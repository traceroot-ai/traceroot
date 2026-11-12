// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import {
  DEFAULT_SCHEDULE_DRAFT,
  ScheduleSection,
  draftToSchedule,
  scheduleProblem,
  type ScheduleDraft,
} from "./schedule-section";

// Radix Select renders through a portal; a native <select> drives onValueChange.
// The trigger's aria-label becomes the <select>'s, so tests find a control by name.
vi.mock("@/components/ui/select", () => {
  const SelectTrigger = (_props: { "aria-label"?: string }) => null;
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: React.ReactNode;
    }) => {
      const trigger = (Array.isArray(children) ? children : [children]).find(
        (c: React.ReactElement) => c?.type === SelectTrigger,
      ) as React.ReactElement<{ "aria-label"?: string }> | undefined;
      return (
        <select
          aria-label={trigger?.props["aria-label"]}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
        >
          {children}
        </select>
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

afterEach(cleanup);

const NOW = new Date("2026-11-11T12:00:00Z");
const draft = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  ...DEFAULT_SCHEDULE_DRAFT,
  timezone: "Europe/Berlin",
  ...over,
});

describe("draftToSchedule / scheduleProblem", () => {
  it("keeps only the fields the kind uses", () => {
    expect(draftToSchedule(draft({ kind: "interval", intervalHours: 4 }))).toEqual({
      kind: "interval",
      intervalHours: 4,
    });
    expect(draftToSchedule(draft({ kind: "daily", hour: 7 }))).toEqual({
      kind: "daily",
      hour: 7,
      timezone: "Europe/Berlin",
    });
    expect(draftToSchedule(draft({ kind: "weekly", weekday: 3 }))).toEqual({
      kind: "weekly",
      weekday: 3,
      hour: 9,
      timezone: "Europe/Berlin",
    });
  });

  it("reports the route's own message for an invalid draft", () => {
    expect(scheduleProblem(draft())).toBeNull();
    expect(scheduleProblem(draft({ timezone: "Mars/Olympus" }))).toBe(
      "timezone must be a valid IANA timezone name",
    );
    expect(scheduleProblem(draft({ kind: "interval", intervalHours: 30 }))).toContain(
      "intervalHours",
    );
    expect(scheduleProblem(draft({ kind: "daily", hour: 24 }))).toContain("hour");
  });
});

describe("ScheduleSection", () => {
  it("shows the next run in the Loop's own zone", () => {
    render(<ScheduleSection value={draft()} onChange={() => {}} now={NOW} />);
    expect(screen.getByTestId("next-run").textContent).toBe("Next run: Thu 12 Nov, 09:00 CET");
  });

  it("shows an interval's next run in UTC and says so", () => {
    render(
      <ScheduleSection
        value={draft({ kind: "interval", intervalHours: 6 })}
        onChange={() => {}}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("next-run").textContent).toContain("Wed 11 Nov, 18:00 UTC");
    expect(screen.getByTestId("next-run").textContent).toContain("in UTC");
  });

  it("offers the fields of the chosen kind only", () => {
    const { rerender } = render(
      <ScheduleSection value={draft({ kind: "interval" })} onChange={() => {}} now={NOW} />,
    );
    expect(screen.queryByLabelText("Hour")).toBeNull();
    expect(screen.queryByLabelText("Timezone")).toBeNull();
    expect(screen.getByLabelText("Interval hours")).toBeTruthy();
    rerender(<ScheduleSection value={draft({ kind: "weekly" })} onChange={() => {}} now={NOW} />);
    expect(screen.getByLabelText("Weekday")).toBeTruthy();
    expect(screen.getByLabelText("Hour")).toBeTruthy();
    expect(screen.getByLabelText("Timezone")).toBeTruthy();
    expect(screen.queryByLabelText("Interval hours")).toBeNull();
  });

  it("changes one field at a time and keeps the others", () => {
    const onChange = vi.fn();
    render(
      <ScheduleSection
        value={draft({ kind: "weekly", weekday: 1 })}
        onChange={onChange}
        now={NOW}
      />,
    );
    fireEvent.change(screen.getByLabelText("Weekday"), { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith(draft({ kind: "weekly", weekday: 5 }));
    fireEvent.change(screen.getByLabelText("Schedule kind"), { target: { value: "interval" } });
    expect(onChange).toHaveBeenLastCalledWith(draft({ kind: "interval", weekday: 1 }));
  });

  it("shows the problem instead of a next run for an invalid draft", () => {
    render(
      <ScheduleSection value={draft({ timezone: "Mars/Olympus" })} onChange={() => {}} now={NOW} />,
    );
    expect(screen.getByTestId("next-run").textContent).toBe(
      "timezone must be a valid IANA timezone name",
    );
  });
});
