// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";
import type { Loop } from "../hooks/use-loops";

const LUNA = { model: "gpt-6-luna", provider: "OpenAI", source: "system", adapter: "openai" };
const GPT55 = { model: "gpt-5.5", provider: "OpenAI", source: "system", adapter: "openai" };

const mocks = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  defaults: { loopDefault: null as unknown, agentDefault: null as unknown, isPending: false },
  zone: "Europe/Berlin" as string | null,
}));

vi.mock("@/features/projects/hooks", () => ({ useProject: () => ({ data: mocks.project }) }));
vi.mock("../hooks/use-loops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/use-loops")>();
  return {
    ...actual,
    useLoopModelDefaults: () => mocks.defaults,
  };
});
vi.mock("../hooks/use-now", () => ({ useBrowserTimezone: () => mocks.zone }));
// The picker's own behaviour is its own test; here it hands the form a selection.
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: (props: {
    value: Record<string, string>;
    onChange: (v: Record<string, string>) => void;
    defaultModelId?: string;
  }) => {
    const { value, onChange } = props;
    // The real picker reconciles a selection it matches without a click: it backfills
    // the adapter, and the provider a legacy selection lacks.
    useEffect(() => {
      if (value.model && value.adapter !== "backfilled") {
        onChange({ ...value, provider: value.provider || "Backfilled", adapter: "backfilled" });
      }
    }, [value, onChange]);
    return (
      <>
        <span data-testid="picked">{JSON.stringify(value)}</span>
        <span data-testid="default-model">{props.defaultModelId ?? ""}</span>
        <button
          type="button"
          onClick={() =>
            onChange({ model: "gpt-5.4", provider: "My OpenAI", source: "byok", adapter: "openai" })
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

import {
  LOOP_INSTRUCTIONS_REQUIRED,
  LOOP_NAME_TAKEN,
  LOOP_NAME_TAKEN_BY_DETECTOR,
} from "@traceroot/core/loops/pure";
import { LoopForm, type LoopFormValues } from "./loop-form";
import { loopModelDefaults } from "../hooks/use-loops";
import type { LLMModelsResponse } from "@/lib/api";

afterEach(cleanup);
beforeEach(() => {
  mocks.project = {
    workspace_id: "ws-1",
    rca_model: "claude-opus-4-1",
    rca_provider: "anthropic",
    rca_source: "system",
  };
  mocks.defaults = { loopDefault: LUNA, agentDefault: GPT55, isPending: false };
  mocks.zone = "Europe/Berlin";
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
      {...props}
    />,
  );
  return onSubmit;
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: /^(Create loop|Save)$/ }));

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

  it("starts a new Loop on the latest default model, not the project's Agent model", () => {
    const onSubmit = setup();
    // The picker shows the default as its default row, as it does the project's.
    expect(JSON.parse(screen.getByTestId("picked").textContent!)).toMatchObject({ model: "" });
    expect(screen.getByTestId("default-model").textContent).toBe("gpt-6-luna");
    expect(screen.getByText(/Starts on the latest default model/)).toBeTruthy();
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-6-luna",
        provider: "OpenAI",
        source: "system",
        template: "coding-agents",
        lookbackHours: 24,
      }),
    );
  });

  it("follows the project's Agent model when the workspace does not offer the default", () => {
    mocks.defaults = { loopDefault: null, agentDefault: GPT55, isPending: false };
    const onSubmit = setup();
    // The picker shows the project's Agent model as its default row, and stores nothing.
    expect(JSON.parse(screen.getByTestId("picked").textContent!)).toMatchObject({ model: "" });
    expect(screen.getByTestId("default-model").textContent).toBe("claude-opus-4-1");
    expect(screen.getByText(/Follows the project's Agent model/)).toBeTruthy();
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ model: null, provider: null, source: null }),
    );
  });

  it("waits for the model list before a create", () => {
    mocks.defaults = { loopDefault: null, agentDefault: null, isPending: true };
    setup();
    expect(
      (screen.getByRole("button", { name: "Create loop" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("caps the name at the route's limit", () => {
    setup();
    expect((screen.getByLabelText("Name") as HTMLInputElement).maxLength).toBe(80);
  });

  it("renders in UTC until the browser's zone is known, then moves the schedule to it", () => {
    mocks.zone = null;
    const props = {
      projectId: "proj-1",
      isPending: false,
      error: null,
      onSubmit: () => {},
      onCancel: () => {},
    };
    const { rerender } = render(<LoopForm {...props} />);
    expect(JSON.parse(screen.getByTestId("draft").textContent!)).toMatchObject({
      timezone: "UTC",
    });
    mocks.zone = "Asia/Tokyo";
    rerender(<LoopForm {...props} />);
    expect(JSON.parse(screen.getByTestId("draft").textContent!)).toMatchObject({
      kind: "daily",
      hour: 9,
      timezone: "Asia/Tokyo",
    });
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

  it("pre-fills the template's instructions, swaps them with the template, and keeps edits", () => {
    setup();
    const box = () => screen.getByLabelText("Instructions") as HTMLTextAreaElement;
    expect(box().value).toContain("first thing that went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(box().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Coding agents" }));
    expect(box().value).toContain("first thing that went wrong");
    fireEvent.change(box(), { target: { value: "my own" } });
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(box().value).toBe("my own");
  });

  it("offers a second template with its own instructions and lookback", () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cost drivers" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Cost drivers");
    expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toContain(
      "where this project's model spend is going",
    );
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ template: "cost-drivers", lookbackHours: 168 }),
    );
  });

  it("needs instructions for every loop, templated or Custom, and says so", () => {
    setup();
    const create = screen.getByRole("button", { name: "Create loop" }) as HTMLButtonElement;
    const box = screen.getByLabelText("Instructions");
    expect(create.disabled).toBe(false);
    expect(screen.queryByText(LOOP_INSTRUCTIONS_REQUIRED)).toBeNull();
    // Clearing a template's pre-filled prompt blocks Create too.
    fireEvent.change(box, { target: { value: "   " } });
    expect(create.disabled).toBe(true);
    expect(screen.getByText(LOOP_INSTRUCTIONS_REQUIRED).id).toBe(
      box.getAttribute("aria-describedby"),
    );
    expect(box.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(create.disabled).toBe(true);
    // The name followed the template and is now empty for Custom.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Timeouts" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Find timeouts" } });
    expect(create.disabled).toBe(false);
    expect(screen.queryByText(LOOP_INSTRUCTIONS_REQUIRED)).toBeNull();
  });

  it("keeps a name the person typed when the template changes", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Loop" } });
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("My Loop");
  });

  it("keeps a schedule the person set when the template changes", () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByText("every 4 hours"));
    fireEvent.click(screen.getByRole("button", { name: "Cost drivers" }));
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        template: "cost-drivers",
        schedule: { kind: "interval", intervalHours: 4 },
      }),
    );
  });

  it("blocks Create while the schedule is invalid", () => {
    setup();
    fireEvent.click(screen.getByText("break schedule"));
    expect(
      (screen.getByRole("button", { name: "Create loop" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows a taken name under the field, and any other failure beside the buttons", () => {
    for (const taken of [LOOP_NAME_TAKEN, LOOP_NAME_TAKEN_BY_DETECTOR]) {
      const { unmount } = render(
        <LoopForm
          projectId="p"
          isPending={false}
          error={new ApiError(409, taken)}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      );
      const message = screen.getByText(taken);
      expect(message.closest("div")?.querySelector("input")).not.toBeNull(); // in the Name section
      unmount();
    }
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

  it("does not blame the name for the loop limit, which is also a 409", () => {
    render(
      <LoopForm
        projectId="p"
        isPending={false}
        error={new ApiError(409, "A project can have at most 5 loops")}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const message = screen.getByText("A project can have at most 5 loops");
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

  it("starts a templated Loop saved with no instructions from its template's prompt", () => {
    const onSubmit = setup({ loop: loop({ template: "coding-agents", instructions: "" }) });
    expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toContain(
      "first thing that went wrong",
    );
    submit();
    expect(onSubmit.mock.calls[0][0].instructions).toContain("first thing that went wrong");
  });

  it("will not save an edit that blanks the instructions", () => {
    const onSubmit = setup({ loop: loop({ template: "coding-agents" }) });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "" } });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(LOOP_INSTRUCTIONS_REQUIRED)).toBeTruthy();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the Loop's own stored model rather than the project's", () => {
    setup({ loop: loop({ model: "gpt-5.4", provider: "My OpenAI", source: "byok" }) });
    expect(JSON.parse(screen.getByTestId("picked").textContent!)).toMatchObject({
      model: "gpt-5.4",
      source: "byok",
    });
    expect(screen.getByTestId("default-model").textContent).toBe("");
  });

  it("shows what an unpinned Loop runs on in a project with no Agent model, and sends no model untouched", () => {
    mocks.project = { workspace_id: "ws-1", rca_model: null, rca_provider: null, rca_source: null };
    const onSubmit = setup({ loop: loop() });
    expect(screen.getByTestId("default-model").textContent).toBe(GPT55.model);
    expect(screen.getByText(/Follows the project's Agent model/)).toBeTruthy();
    submit();
    const values = onSubmit.mock.calls[0][0];
    expect(values).not.toHaveProperty("model");
    expect(values).not.toHaveProperty("provider");
    expect(values).not.toHaveProperty("source");
  });

  it("sends no model for an untouched edit the picker backfilled a legacy provider on", () => {
    const onSubmit = setup({ loop: loop({ model: "gpt-5.4", provider: null, source: "system" }) });
    expect(JSON.parse(screen.getByTestId("picked").textContent!)).toMatchObject({
      model: "gpt-5.4",
      provider: "Backfilled",
    });
    expect(screen.getByText(/Pick another model to change/)).toBeTruthy();
    submit();
    const values = onSubmit.mock.calls[0][0];
    expect(values).not.toHaveProperty("model");
    expect(values).not.toHaveProperty("provider");
    expect(values).not.toHaveProperty("source");
  });

  it("sends a model picked on an edit", () => {
    const onSubmit = setup({ loop: loop() });
    fireEvent.click(screen.getByText("pick byok"));
    expect(screen.getByText("This loop runs on the model picked here.")).toBeTruthy();
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.4", provider: "My OpenAI", source: "byok" }),
    );
  });

  it("offers no template picker, and keeps the stored lookback and instructions", () => {
    const onSubmit = setup({ loop: loop({ template: "coding-agents", instructions: "mine" }) });
    expect(screen.queryByRole("button", { name: "Cost drivers" })).toBeNull();
    expect(screen.queryByText("Template", { selector: "span" })).toBeNull();
    submit();
    const values = onSubmit.mock.calls[0][0];
    expect(values).toMatchObject({ template: "coding-agents", instructions: "mine" });
    expect(values).not.toHaveProperty("lookbackHours");
  });

  it("labels the save button for an edit", () => {
    setup({ loop: loop() });
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("puts the sections in the detector form's order and read-only extras before the actions", () => {
    setup({ loop: loop(), children: <p>memory notes</p> });
    const labels = ["Name", "Model", "Instructions", "Findings"].map((l) =>
      screen.getByText(l, { selector: "span" }),
    );
    const extra = screen.getByText("memory notes");
    const save = screen.getByRole("button", { name: "Save" });
    const order = [...labels, extra, save];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });
});

describe("loopModelDefaults", () => {
  const response = (systemIds: string[]) =>
    ({
      systemModels: [
        {
          provider: "OpenAI",
          adapter: "openai",
          models: systemIds.map((id) => ({ id, label: id })),
        },
      ],
      byokProviders: [],
    }) as unknown as LLMModelsResponse;

  it("starts on the detector default when the workspace offers it", () => {
    expect(loopModelDefaults(response(["gpt-5.5", "gpt-6-luna"])).loopDefault).toEqual(LUNA);
  });

  it("starts on nothing (the project's Agent model) when it does not", () => {
    const d = loopModelDefaults(response(["gpt-5.5"]));
    expect(d.loopDefault).toBeNull();
    expect(d.agentDefault).toMatchObject({ model: "gpt-5.5" });
    expect(loopModelDefaults(undefined)).toEqual({ loopDefault: null, agentDefault: null });
  });
});
