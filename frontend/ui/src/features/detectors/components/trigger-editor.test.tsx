// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { MAX_FILTERS } from "@/features/filters/predicate";
import type { TriggerCondition } from "../trigger-fields";

const mockUseFilterValues = vi.hoisted(() =>
  vi.fn((): { values: { value: string; count?: number }[]; isLoading: boolean } => ({
    values: [],
    isLoading: false,
  })),
);
vi.mock("@/features/filters/hooks", () => ({
  useFilterValues: mockUseFilterValues,
  useMetadataKeys: () => ({ keys: [], isLoading: false }),
}));

import { TriggerEditor } from "./trigger-editor";

/** Server-observed values for the row's field, as the suggestions endpoint answers. */
function observeValues(values: { value: string; count?: number }[]) {
  mockUseFilterValues.mockReturnValue({ values, isLoading: false });
}

function renderEditor(
  conditions: TriggerCondition[],
  props: { onChange?: (c: TriggerCondition[]) => void; onSave?: (c: TriggerCondition[]) => void },
) {
  render(<TriggerEditor conditions={conditions} projectId="proj-1" {...props} />);
}

const valueInput = () => screen.getByLabelText("value") as HTMLInputElement;
const lastCall = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[spy.mock.calls.length - 1][0];

afterEach(() => {
  cleanup();
  mockUseFilterValues.mockReturnValue({ values: [], isLoading: false });
});

describe("TriggerEditor — the value control for a field with no observed values", () => {
  it("stays a text input across keystrokes so a whole word can be typed", () => {
    const onChange = vi.fn();
    renderEditor([{ field: "environment", op: "=", value: "" }], { onChange });

    fireEvent.change(valueInput(), { target: { value: "s" } });
    expect(valueInput().tagName).toBe("INPUT");
    fireEvent.change(valueInput(), { target: { value: "staging" } });

    expect(valueInput().value).toBe("staging");
    expect(lastCall(onChange)).toEqual([{ field: "environment", op: "=", value: "staging" }]);
  });
});

describe("TriggerEditor — the value control for a field with observed values", () => {
  it("is a dropdown from the start and stays one after a value is picked", () => {
    observeValues([{ value: "prod", count: 3 }]);
    const onChange = vi.fn();
    renderEditor([{ field: "environment", op: "=", value: "" }], { onChange });

    expect(screen.queryByLabelText("value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter value" }));
    fireEvent.click(screen.getByRole("option", { name: /prod/ }));

    expect(lastCall(onChange)).toEqual([{ field: "environment", op: "=", value: "prod" }]);
    expect(screen.queryByLabelText("value")).toBeNull();
  });
});

describe("TriggerEditor — picking a field on a row that already has one", () => {
  it("keeps the operator and value when the field picked is the one already there", () => {
    const onChange = vi.fn();
    renderEditor([{ field: "cost", op: ">=", value: "250" }], { onChange });

    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    fireEvent.click(screen.getByRole("option", { name: "Cost" }));

    expect(lastCall(onChange)).toEqual([{ field: "cost", op: ">=", value: "250" }]);
    expect(valueInput().value).toBe("250");
  });

  it("resets the operator and value when a different field is picked", () => {
    const onChange = vi.fn();
    renderEditor([{ field: "cost", op: ">=", value: "250" }], { onChange });

    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    fireEvent.click(screen.getByRole("option", { name: "Tokens" }));

    expect(lastCall(onChange)).toEqual([{ field: "total_tokens", op: ">", value: "" }]);
  });
});

describe("TriggerEditor — a number typed into a filter row", () => {
  it("keeps a long digit string exactly as typed and saves it as a number", () => {
    const onSave = vi.fn();
    renderEditor([{ field: "cost", op: ">", value: "" }], { onSave });

    fireEvent.change(valueInput(), { target: { value: "1111111111111111111111" } });
    expect(valueInput().value).toBe("1111111111111111111111");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith([{ field: "cost", op: ">", value: 1.1111111111111111e21 }]);
  });

  it("saves a fractional value as a number, not the typed string", () => {
    const onSave = vi.fn();
    renderEditor([{ field: "cost", op: ">", value: "" }], { onSave });

    fireEvent.change(valueInput(), { target: { value: "0.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([{ field: "cost", op: ">", value: 0.25 }]);
  });
});

describe("TriggerEditor — saving a metadata row", () => {
  it("saves the metadata key without the whitespace around it", () => {
    const onSave = vi.fn();
    renderEditor([{ field: "metadata", op: "=", value: "acme", key: "tenant" }], { onSave });

    fireEvent.change(screen.getByLabelText("metadata key"), { target: { value: " tenant " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([
      { field: "metadata", op: "=", value: "acme", key: "tenant" },
    ]);
  });
});

describe("TriggerEditor — why its own Save is blocked", () => {
  it("shows the reason as readable text beside the disabled button", () => {
    renderEditor([{ field: "cost", op: ">", value: "5" }], { onSave: vi.fn() });
    fireEvent.change(valueInput(), { target: { value: "" } });

    expect(screen.getByText("condition 1 requires a non-negative number")).toBeDefined();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("TriggerEditor — the filter cap the write path enforces", () => {
  const atCap = (): TriggerCondition[] =>
    Array.from({ length: MAX_FILTERS }, () => ({ field: "cost", op: ">", value: "1" }));

  it("adds no further row once the cap is reached", () => {
    const onChange = vi.fn();
    render(
      <TriggerEditor conditions={atCap()} projectId="proj-1" onChange={onChange} />, // header variant
    );

    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));

    expect(screen.getAllByLabelText("value")).toHaveLength(MAX_FILTERS);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables Add condition at the cap", () => {
    render(<TriggerEditor conditions={atCap()} projectId="proj-1" onChange={vi.fn()} asCard />);
    const add = screen.getByRole("button", { name: "Add condition" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  it("offers Add condition below the cap", () => {
    render(
      <TriggerEditor
        conditions={atCap().slice(0, MAX_FILTERS - 1)}
        projectId="proj-1"
        onChange={vi.fn()}
        asCard
      />,
    );
    const add = screen.getByRole("button", { name: "Add condition" }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(screen.getAllByLabelText("value")).toHaveLength(MAX_FILTERS);
  });
});
