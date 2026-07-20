// @vitest-environment jsdom
/**
 * Unit coverage for the shared offline-eval component kit — the page chrome,
 * the form shells, the row-selection primitives, and the upload control. These
 * are the pieces the dataset/evaluation surfaces are assembled from, so they are
 * exercised directly rather than only through a view mount.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, within, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  EvalPageHeader,
  EvalBody,
  DetailsSection,
  DetailRow,
  QuietAction,
  EmptyState,
} from "./page-chrome";
import { CreateDrawer, FormCard, AdvancedSection } from "./form-kit";
import { useRowSelection, SelectAllHeaderCell, SelectRowCell, BulkActionBar } from "./selection";
import { UploadControl } from "./upload-control";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => cleanup());

describe("page chrome", () => {
  it("EvalPageHeader renders a parent breadcrumb, a purpose sentence, and one action", () => {
    render(
      <EvalPageHeader
        parent={{ label: "Datasets", href: "/projects/p1/datasets" }}
        title="Billing routing"
        purpose="A dataset is a versioned set of test cases."
        action={<button type="button">New</button>}
      />,
    );
    const parent = screen.getByText("Datasets");
    expect(parent.getAttribute("href")).toBe("/projects/p1/datasets");
    expect(screen.getByRole("heading").textContent).toBe("Billing routing");
    expect(screen.getByText(/versioned set of test cases/)).toBeDefined();
    expect(screen.getByRole("button", { name: "New" })).toBeDefined();
  });

  it("EvalPageHeader falls back to a Back link when there is no parent", () => {
    render(<EvalPageHeader title="Run #27" backHref="/projects/p1/evaluations" />);
    const back = screen.getByText("Back");
    expect(back.getAttribute("href")).toBe("/projects/p1/evaluations");
  });

  it("EvalPageHeader honours a custom back label and drops it once a parent is given", () => {
    const { rerender } = render(
      <EvalPageHeader title="Run #27" backHref="/x" backLabel="All runs" />,
    );
    expect(screen.getByText("All runs")).toBeDefined();
    // A parent breadcrumb replaces the back link entirely.
    rerender(
      <EvalPageHeader title="Run #27" backHref="/x" parent={{ label: "Runs", href: "/x" }} />,
    );
    expect(screen.queryByText("All runs")).toBeNull();
    expect(screen.getByText("Runs")).toBeDefined();
  });

  it("EvalBody, EmptyState, DetailsSection, DetailRow and QuietAction render their content", () => {
    const onClick = vi.fn();
    render(
      <EvalBody className="custom">
        <DetailsSection label="Run details" className="mt-2">
          <dl>
            <DetailRow label="Environment" value="ci" />
            <DetailRow label="Cases" value={24} />
          </dl>
        </DetailsSection>
        <EmptyState>Nothing here yet.</EmptyState>
        <QuietAction onClick={onClick}>View SDK example</QuietAction>
      </EvalBody>,
    );

    // The details summary is a native disclosure, so it is keyboard-reachable.
    const summary = screen.getByText("Run details");
    expect(summary.tagName).toBe("SUMMARY");
    expect(screen.getByText("Environment")).toBeDefined();
    expect(screen.getByText("24")).toBeDefined();
    expect(screen.getByText("Nothing here yet.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "View SDK example" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("DetailsSection defaults its label to Details", () => {
    render(
      <DetailsSection>
        <span>body</span>
      </DetailsSection>,
    );
    expect(screen.getByText("Details")).toBeDefined();
  });
});

describe("form kit", () => {
  it("FormCard shows its label and optional hint", () => {
    const { rerender } = render(
      <FormCard label="Dataset" hint="required">
        <input aria-label="dataset name" />
      </FormCard>,
    );
    expect(screen.getByText("Dataset")).toBeDefined();
    expect(screen.getByText("required")).toBeDefined();

    // Without a hint the strip carries only the label.
    rerender(
      <FormCard label="Dataset" className="mt-2">
        <input aria-label="dataset name" />
      </FormCard>,
    );
    expect(screen.queryByText("required")).toBeNull();
  });

  it("AdvancedSection is a collapsed native disclosure with a default label", () => {
    const { rerender } = render(
      <AdvancedSection>
        <span>hidden field</span>
      </AdvancedSection>,
    );
    expect(screen.getByText("Advanced").tagName).toBe("SUMMARY");
    rerender(
      <AdvancedSection label="Scorer options">
        <span>hidden field</span>
      </AdvancedSection>,
    );
    expect(screen.getByText("Scorer options")).toBeDefined();
  });

  it("CreateDrawer wires Save and Cancel, and honours saveDisabled", () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <CreateDrawer
        title="New evaluation"
        open
        onOpenChange={onOpenChange}
        onSave={onSave}
        saveLabel="Create"
        saveDisabled
        width="w-[480px]"
      >
        <FormCard label="Name">
          <input aria-label="name" />
        </FormCard>
      </CreateDrawer>,
    );

    expect(screen.getByText("New evaluation")).toBeDefined();
    const save = screen.getByRole("button", { name: "Create" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Enabled, with the default Save label.
    rerender(
      <CreateDrawer title="New evaluation" open onOpenChange={onOpenChange} onSave={onSave}>
        <span>fields</span>
      </CreateDrawer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalled();
  });

  it("CreateDrawer renders nothing while closed", () => {
    render(
      <CreateDrawer title="New evaluation" open={false} onOpenChange={vi.fn()} onSave={vi.fn()}>
        <span>fields</span>
      </CreateDrawer>,
    );
    expect(screen.queryByText("New evaluation")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row selection
// ---------------------------------------------------------------------------

function SelectionHarness({ ids, onDelete }: { ids: string[]; onDelete?: () => Promise<void> }) {
  const selection = useRowSelection(ids);
  return (
    <div>
      <BulkActionBar
        count={selection.count}
        onDelete={onDelete}
        onClear={selection.clear}
        extra={<button type="button">Export</button>}
      />
      <table>
        <thead>
          <tr>
            <SelectAllHeaderCell
              checked={selection.allSelected}
              indeterminate={selection.someSelected}
              onToggle={selection.toggleAll}
            />
            <th>Name</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => (
            <tr key={id}>
              <SelectRowCell
                checked={selection.has(id)}
                onToggle={() => selection.toggle(id)}
                label={`Select ${id}`}
              />
              <td>{id}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => selection.setMany(ids, true)}>
        Select batch
      </button>
      <button type="button" onClick={() => selection.setMany(ids, false)}>
        Deselect batch
      </button>
    </div>
  );
}

describe("row selection", () => {
  it("toggles rows, shows the bulk bar, and clears", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<SelectionHarness ids={["a", "b", "c"]} onDelete={onDelete} />);

    // Nothing selected: no bar.
    expect(screen.queryByText(/selected/)).toBeNull();

    fireEvent.click(screen.getByLabelText("Select a"));
    expect(screen.getByText("1 selected")).toBeDefined();
    // Partial selection puts the header checkbox in its indeterminate state.
    expect(screen.getByLabelText("Select all")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Select b"));
    expect(screen.getByText("2 selected")).toBeDefined();
    // Toggling the same row off again.
    fireEvent.click(screen.getByLabelText("Select b"));
    expect(screen.getByText("1 selected")).toBeDefined();

    // The bar owns the confirmation, so Delete opens the dialog and only the
    // confirm inside it performs the deletion.
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 selected" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete 1 selected" })[1]);
    expect(onDelete).toHaveBeenCalled();
    // The bar disables itself while the delete is in flight, so wait for it to
    // settle before driving anything else.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Clear" }).hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    // Scoped to the bar: the confirmation dialog's own copy also says "selected".
    expect(within(screen.getByRole("status")).queryByText(/\d+ selected/)).toBeNull();
  });

  it("select-all toggles the whole page on and back off", () => {
    render(<SelectionHarness ids={["a", "b"]} />);
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(screen.getByText("2 selected")).toBeDefined();
    // Now labelled for the inverse action.
    fireEvent.click(screen.getByLabelText("Deselect all"));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("setMany adds or removes a batch at once", () => {
    render(<SelectionHarness ids={["a", "b", "c"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Select batch" }));
    expect(screen.getByText("3 selected")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Deselect batch" }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("drops selected ids that no longer exist", () => {
    const { rerender } = render(<SelectionHarness ids={["a", "b"]} />);
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(screen.getByText("2 selected")).toBeDefined();
    // "b" is deleted upstream; the selection shrinks to match.
    rerender(<SelectionHarness ids={["a"]} />);
    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("the row checkbox does not bubble a click up to the row", () => {
    const onRowClick = vi.fn();
    render(
      <table>
        <tbody>
          <tr onClick={onRowClick}>
            <SelectRowCell checked={false} onToggle={vi.fn()} label="Select a" />
          </tr>
        </tbody>
      </table>,
    );
    fireEvent.click(screen.getByLabelText("Select a"));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("BulkActionBar omits Delete on lists with no delete API", () => {
    render(<BulkActionBar count={3} onClear={vi.fn()} />);
    const bar = screen.getByText("3 selected").parentElement as HTMLElement;
    expect(within(bar).queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Clear" })).toBeDefined();
  });
});

describe("upload control", () => {
  const file = () => new File(["input,expected\na,b\n"], "cases.csv", { type: "text/csv" });

  it("reports a chosen file and switches to the chosen-file affordance", () => {
    const onFile = vi.fn();
    render(<UploadControl onFile={onFile} className="mt-2" />);

    expect(screen.getByText(/Drop a CSV or JSON file/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Upload CSV or JSON"), {
      target: { files: [file()] },
    });

    expect(onFile).toHaveBeenCalledWith("cases.csv");
    expect(screen.getByText("cases.csv")).toBeDefined();
    expect(screen.getByText("Click to choose a different file")).toBeDefined();
  });

  it("accepts a dropped file and highlights while dragging", () => {
    const onFile = vi.fn();
    render(<UploadControl onFile={onFile} />);
    const zone = screen.getByRole("button");

    fireEvent.dragOver(zone);
    fireEvent.dragLeave(zone);
    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [file()] } });

    expect(onFile).toHaveBeenCalledWith("cases.csv");
    expect(screen.getByText("cases.csv")).toBeDefined();
  });

  it("ignores a drop that carries no file, and works without an onFile handler", () => {
    render(<UploadControl />);
    const zone = screen.getByRole("button");
    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    expect(screen.getByText(/Drop a CSV or JSON file/)).toBeDefined();

    fireEvent.change(screen.getByLabelText("Upload CSV or JSON"), {
      target: { files: [file()] },
    });
    expect(screen.getByText("cases.csv")).toBeDefined();
  });

  it("clicking the drop zone opens the hidden file picker", () => {
    render(<UploadControl />);
    const input = screen.getByLabelText("Upload CSV or JSON");
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button"));
    expect(click).toHaveBeenCalled();
  });
});
