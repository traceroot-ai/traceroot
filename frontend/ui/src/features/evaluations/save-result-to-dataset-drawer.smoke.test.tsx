// @vitest-environment jsdom
/**
 * The result→dataset drawer: one RESULT saved back into a dataset three ways
 * (update its source case / save a new case / duplicate as a variant). These mounts
 * assert the two product invariants the UI must uphold alongside the backend:
 *  - a candidate's output NEVER becomes the expected answer unless the reviewer
 *    explicitly opts in (the toggle, off by default); and
 *  - "update" derives its dataset from the result (no picker), while "save/duplicate"
 *    require an explicit target dataset.
 * It also surfaces the backend's actionable 409 (circular save) verbatim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

// Radix Select portals + is flaky in jsdom; mock to a native <select> (the pattern
// used by save-test-case-drawer.smoke.test.tsx) so the dataset picker is drivable.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select aria-label="Dataset" value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectEmpty: ({ children }: { children: React.ReactNode }) => (
    <option disabled>{children}</option>
  ),
}));

import {
  SaveResultToDatasetDrawer,
  type ResultDatasetAction,
} from "./components/save-result-to-dataset-drawer";

const RESULT = {
  id: "res1",
  input: "Produce a report about Q2 performance",
  expectedOutput: null,
  candidateOutput: "Q2 revenue grew 12% QoQ.",
  testCaseId: "case-1",
};

function stubFetch(postResponse?: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const r = postResponse ?? {
        ok: true,
        status: 201,
        body: { dataset_id: "ds1", version_id: "v2", version_number: 2, test_case_id: "case-1" },
      };
      return { ok: r.ok, status: r.status, json: async () => r.body } as Response;
    }
    // useDatasets list.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "ds1", name: "Billing routing", caseCount: 2, versionCount: 1 },
          { id: "ds2", name: "Report quality", caseCount: 5, versionCount: 3 },
        ],
        meta: { page: 0, limit: 200, total: 2 },
      }),
    } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mount(action: ResultDatasetAction, onOpenChange = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SaveResultToDatasetDrawer
          projectId="p1"
          open
          onOpenChange={onOpenChange}
          action={action}
          result={RESULT}
          sourceDatasetId="ds1"
          sourceDatasetName="Billing routing"
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function lastPost(fetchMock: ReturnType<typeof stubFetch>) {
  const call = fetchMock.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === "POST",
  );
  return {
    url: call?.[0] as string,
    body: JSON.parse((call?.[1] as RequestInit).body as string),
  };
}

afterEach(() => cleanup());
beforeEach(() => {
  stubFetch();
});

describe("SaveResultToDatasetDrawer", () => {
  it("update derives the dataset from the result — no dataset picker, source case shown", () => {
    mount("update_existing_case");
    expect(screen.getByText("Update source case")).toBeDefined();
    // The source case is stated, and there is NO dataset chooser for update.
    expect(screen.getByText("Billing routing")).toBeDefined();
    expect(screen.getByText("case-1")).toBeDefined();
    expect(screen.queryByLabelText("Dataset")).toBeNull();
  });

  it("save-new requires a target dataset picker", () => {
    mount("save_new_case");
    expect(screen.getByText("Save as a new case")).toBeDefined();
    expect(screen.getByLabelText("Dataset")).toBeDefined();
  });

  it("disables Save until a field is edited or dataset changes", () => {
    mount("update_existing_case");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);

    const input = screen.getByLabelText("Input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "A different question" } });
    expect(save.hasAttribute("disabled")).toBe(false);

    fireEvent.change(input, { target: { value: RESULT.input } });
    expect(save.hasAttribute("disabled")).toBe(true);

    // Toggling the candidate switch enables Save
    fireEvent.click(screen.getByRole("switch"));
    expect(save.hasAttribute("disabled")).toBe(false);
  });

  it("never copies the candidate output into expected unless explicitly toggled on", async () => {
    const fetchMock = stubFetch();
    mount("update_existing_case");
    // Type a real reference answer; the candidate output is a DIFFERENT string.
    const expected = screen.getByLabelText("Expected answer") as HTMLTextAreaElement;
    fireEvent.change(expected, { target: { value: "A concise Q2 summary." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "POST")).toBe(true),
    );
    const { url, body } = await lastPost(fetchMock);
    expect(url).toBe("/api/projects/p1/evaluations/results/res1/dataset-case");
    expect(body.action).toBe("update_existing_case");
    expect(body.use_candidate_as_expected).toBe(false);
    expect(body.expected).toBe("A concise Q2 summary.");
    // The candidate's own text must not leak into `expected`.
    expect(body.expected).not.toBe(RESULT.candidateOutput);
  });

  it("promotes the candidate to expected ONLY through the explicit flag", async () => {
    const fetchMock = stubFetch();
    mount("update_existing_case");
    // Flipping the toggle hides the free-text field and shows the candidate output.
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText(RESULT.candidateOutput)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "POST")).toBe(true),
    );
    const { body } = await lastPost(fetchMock);
    expect(body.use_candidate_as_expected).toBe(true);
    // `expected` is NOT sent — the server derives it from the candidate under the flag.
    expect(body.expected).toBeUndefined();
  });

  it("surfaces the backend's actionable circular-save conflict verbatim", async () => {
    const fetchMock = stubFetch({
      ok: false,
      status: 409,
      body: { error: "This result already came from this case — use update instead." },
    });
    mount("save_new_case");
    // ds1 is the source dataset (default); saving a new case that recreates the source
    // is what the backend rejects. Save stays disabled until the datasets list has
    // loaded and confirms ds1 is a real, current dataset.
    const saveBtn = screen.getByRole("button", { name: /^Save$/i }) as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/use update instead/i),
    );
    expect(fetchMock).toHaveBeenCalled();
  });
});
