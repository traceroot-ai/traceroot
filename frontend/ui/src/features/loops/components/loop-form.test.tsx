// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";
import type { Loop } from "../hooks/use-loops";

const mocks = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  selectorProps: null as Record<string, unknown> | null,
}));

vi.mock("@/features/projects/hooks", () => ({ useProject: () => ({ data: mocks.project }) }));
// The picker's own behaviour is its own test; here it hands the form a selection.
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: (props: {
    value: Record<string, string>;
    onChange: (v: Record<string, string>) => void;
  }) => {
    mocks.selectorProps = props;
    return (
      <>
        <span data-testid="picked">{JSON.stringify(props.value)}</span>
        <button
          type="button"
          onClick={() =>
            props.onChange({
              model: "gpt-5.4",
              provider: "My OpenAI",
              source: "byok",
              adapter: "openai",
            })
          }
        >
          pick byok
        </button>
      </>
    );
  },
}));
vi.mock("./schedule-section", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./schedule-section")>();
  return {
    ...actual,
    ScheduleSection: ({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) => (
      <>
        <span data-testid="draft">{JSON.stringify(value)}</span>
        <button
          type="button"
          onClick={() => onChange({ ...(value as object), timezone: "Mars/Olympus" })}
        >
          break schedule
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...(value as object), kind: "interval", intervalHours: 4 })}
        >
          every 4 hours
        </button>
      </>
    ),
  };
});

import { LoopForm, type LoopFormValues } from "./loop-form";

afterEach(cleanup);
beforeEach(() => {
  mocks.project = {
    workspace_id: "ws-1",
    rca_model: "claude-opus-4-1",
    rca_provider: "anthropic",
    rca_source: "system",
  };
});

function setup(props: Partial<React.ComponentProps<typeof LoopForm>> = {}) {
  const onSubmit = vi.fn<(v: LoopFormValues) => void>();
  render(
    <LoopForm
      projectId="proj-1"
      isPending={false}
      error={null}
      onSubmit={onSubmit}
      onCancel={() => {}}
      defaultTimezone="Europe/Berlin"
      {...props}
    />,
  );
  return onSubmit;
}
const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: /Create Loop|Save changes/ }));

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "l1",
    name: "Release regressions",
    template: null,
    instructions: "compare releases",
    schedule: { kind: "weekly", weekday: 2, hour: 7, timezone: "UTC" },
    dryRun: true,
    model: null,
    provider: null,
    source: null,
    ...over,
  }) as Loop;

describe("create", () => {
  it("starts on the first template, named for it, with its schedule in the browser's zone", () => {
    setup();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Coding agents");
    expect(screen.getByRole("button", { name: "Coding agents" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(JSON.parse(screen.getByTestId("draft").textContent!)).toMatchObject({
      kind: "daily",
      hour: 9,
      timezone: "Europe/Berlin",
    });
  });

  it("seeds the picker from the project's Agent model, and an untouched picker saves no model (follow the project)", () => {
    const onSubmit = setup();
    expect(JSON.parse(screen.getByTestId("picked").textContent!)).toEqual({
      model: "claude-opus-4-1",
      provider: "anthropic",
      source: "system",
      adapter: "",
    });
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        model: null,
        provider: null,
        source: null,
        template: "coding-agents",
        lookbackHours: 24,
      }),
    );
  });

  it("saves a picked BYOK model with source byok and its provider", () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByText("pick byok"));
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.4", provider: "My OpenAI", source: "byok" }),
    );
  });

  it("sends the schedule the section built, and the dry-run switch", () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByText("every 4 hours"));
    fireEvent.click(screen.getByRole("switch"));
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: { kind: "interval", intervalHours: 4 }, dryRun: true }),
    );
  });

  it("a template needs no instructions; Custom does", () => {
    setup();
    const create = screen.getByRole("button", { name: "Create Loop" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(create.disabled).toBe(true);
    expect(screen.getByText("Custom Loops need instructions.")).toBeTruthy();
    // The name followed the template and is now empty for Custom.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Timeouts" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Find timeouts" } });
    expect(create.disabled).toBe(false);
  });

  it("keeps a name the person typed when the template changes", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Loop" } });
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("My Loop");
  });

  it("blocks Create while the schedule is invalid", () => {
    setup();
    fireEvent.click(screen.getByText("break schedule"));
    expect(
      (screen.getByRole("button", { name: "Create Loop" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows a taken name under the field, and any other failure beside the buttons", () => {
    const { unmount } = render(
      <LoopForm
        projectId="p"
        isPending={false}
        error={new ApiError(409, "A Loop with this name already exists")}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("A Loop with this name already exists")).toBeTruthy();
    unmount();
    render(
      <LoopForm
        projectId="p"
        isPending={false}
        error={new ApiError(400, "schedule is bad")}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("schedule is bad")).toBeTruthy();
  });

  it("does not blame the name for the Loop limit, which is also a 409", () => {
    render(
      <LoopForm
        projectId="p"
        isPending={false}
        error={new ApiError(409, "A project can have at most 5 Loops")}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const message = screen.getByText("A project can have at most 5 Loops");
    expect(message.closest("div")?.querySelector("input")).toBeNull(); // not inside the Name section
  });
});

describe("edit", () => {
  it("fills the form from the Loop and leaves the model fields out when the picker was not touched", () => {
    const onSubmit = setup({ loop: loop() });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Release regressions");
    expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe(
      "compare releases",
    );
    expect(JSON.parse(screen.getByTestId("draft").textContent!)).toMatchObject({
      kind: "weekly",
      weekday: 2,
      hour: 7,
      timezone: "UTC",
    });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    submit();
    const values = onSubmit.mock.calls[0][0];
    expect(values).toMatchObject({ name: "Release regressions", template: null, dryRun: true });
    expect(values).not.toHaveProperty("model");
    expect(values).not.toHaveProperty("source");
  });

  it("shows the Loop's own stored model rather than the project's", () => {
    setup({ loop: loop({ model: "gpt-5.4", provider: "My OpenAI", source: "byok" }) });
    expect(JSON.parse(screen.getByTestId("picked").textContent!)).toMatchObject({
      model: "gpt-5.4",
      source: "byok",
    });
  });

  it("labels the save button for an edit", () => {
    setup({ loop: loop() });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });
});
