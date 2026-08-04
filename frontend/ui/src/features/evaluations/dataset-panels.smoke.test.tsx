// @vitest-environment jsdom
/**
 * View-mount smoke for the New-dataset and Edit-dataset slide-in panels, driven
 * from the real Datasets list (the only place they open from) against a stubbed
 * fetch. Covers the shared DatasetFormFields — including the schema toggles that
 * only appear once switched on — and the create/update round trips.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/datasets",
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

import { DatasetsView } from "./views/datasets-view";

const DATASET = {
  id: "ds1",
  projectId: "p1",
  name: "Billing routing",
  description: "Routing tickets",
  currentVersionId: "dv1",
  createTime: "2026-07-16T00:00:00Z",
  updateTime: "2026-07-17T00:00:00Z",
  caseCount: 8,
  versionCount: 3,
};

let requests: Array<{ url: string; method: string; body: unknown }> = [];
/** Flipped by a test to make every write fail, exercising the error toasts. */
let writesFail = false;

function payloadFor(url: string): unknown {
  if (url.includes("/evaluations")) {
    return { data: [{ id: "eval1", name: "Billing routing", datasetId: "ds1" }] };
  }
  if (url.includes("/datasets")) {
    return { data: [DATASET], meta: { page: 0, limit: 50, total: 1 } };
  }
  return {};
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

beforeEach(() => {
  requests = [];
  writesFail = false;
  mockPush.mockClear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({
      url: String(url),
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (writesFail && method !== "GET") {
      return { ok: false, status: 500, json: async () => ({ error: "server exploded" }) };
    }
    return { ok: true, status: 200, json: async () => payloadFor(String(url)) };
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DatasetsView projectId="p1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Opens the row's three-dot menu and picks an item. */
async function rowAction(name: "Edit" | "Delete") {
  fireEvent.click(await screen.findByLabelText("Row actions"));
  fireEvent.click(await screen.findByText(name));
}

describe("New dataset panel", () => {
  it("stays disabled until a name is typed, then POSTs name + description", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New Dataset" }));

    const create = screen.getByRole("button", { name: "Create dataset" });
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("e.g. Billing routing"), {
      target: { value: "  Refund routing  " },
    });
    fireEvent.change(screen.getByPlaceholderText("What this collection of test cases is for"), {
      target: { value: "Refund tickets" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create dataset" }));
    expect(await screen.findByText("Dataset created")).toBeDefined();

    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toContain("/api/projects/p1/datasets");
    expect(post?.body).toEqual({ name: "Refund routing", description: "Refund tickets" });
    // Creating closes the panel.
    await waitFor(() => expect(screen.queryByText("New dataset")).toBeNull());
  });

  it("an empty description persists as null, never as an empty string", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New Dataset" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Billing routing"), {
      target: { value: "Refund routing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create dataset" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({
      name: "Refund routing",
      description: null,
    });
  });

  it("the schema cards reveal an editable JSON block only once switched on", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New Dataset" }));

    expect(screen.queryByLabelText("Input schema JSON")).toBeNull();
    const [inputSwitch, expectedSwitch] = screen.getAllByRole("switch");

    fireEvent.click(inputSwitch);
    const inputSchema = (await screen.findByLabelText("Input schema JSON")) as HTMLTextAreaElement;
    expect(inputSchema.value).toContain('"required": ["input"]');
    fireEvent.change(inputSchema, { target: { value: '{"type":"string"}' } });
    expect((screen.getByLabelText("Input schema JSON") as HTMLTextAreaElement).value).toContain(
      '{"type":"string"}',
    );

    fireEvent.click(expectedSwitch);
    expect(
      ((await screen.findByLabelText("Expected output schema JSON")) as HTMLTextAreaElement).value,
    ).toContain('"required": ["expected"]');

    // Toggling back off hides the block again.
    fireEvent.click(inputSwitch);
    await waitFor(() => expect(screen.queryByLabelText("Input schema JSON")).toBeNull());
  });

  it("accepts free-form metadata", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New Dataset" }));
    const metadata = screen.getByLabelText("Metadata") as HTMLTextAreaElement;
    fireEvent.change(metadata, { target: { value: '{"team":"support"}' } });
    expect((screen.getByLabelText("Metadata") as HTMLTextAreaElement).value).toContain("support");
  });

  it("closes on Cancel, on the X, and on Escape", async () => {
    mount();
    const open = await screen.findByRole("button", { name: "New Dataset" });

    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("New dataset")).toBeNull());

    fireEvent.click(open);
    fireEvent.click(await screen.findByLabelText("Close"));
    await waitFor(() => expect(screen.queryByText("New dataset")).toBeNull());

    fireEvent.click(open);
    await screen.findByText("New dataset");
    // The panel is a Radix drawer, which listens for Escape on the document via its
    // dismissable layer — an event dispatched straight at `window` never reaches it.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("New dataset")).toBeNull());
  });

  it("surfaces a create failure as a warning toast and keeps the panel open", async () => {
    writesFail = true;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New Dataset" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Billing routing"), {
      target: { value: "Refund routing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create dataset" }));
    expect(await screen.findByText("Could not create dataset")).toBeDefined();
    expect(screen.getByText("New dataset")).toBeDefined();
  });
});

describe("Edit dataset panel", () => {
  it("opens seeded from the row and PATCHes the edited name", async () => {
    mount();
    await rowAction("Edit");

    // Seeded from the dataset row.
    const name = (await screen.findByPlaceholderText("e.g. Billing routing")) as HTMLInputElement;
    expect(name.value).toBe("Billing routing");
    expect(
      (screen.getByPlaceholderText("What this collection of test cases is for") as HTMLInputElement)
        .value,
    ).toBe("Routing tickets");

    fireEvent.change(name, { target: { value: "Billing routing v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Dataset saved")).toBeDefined();

    const patch = requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toContain("/api/projects/p1/datasets/ds1");
    expect(patch?.body).toEqual({ name: "Billing routing v2", description: "Routing tickets" });
  });

  it("copies the dataset id from the header chip", async () => {
    mount();
    await rowAction("Edit");
    fireEvent.click(await screen.findByTitle("Copy dataset ID"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ds1"));
  });

  it("surfaces a save failure and closes on Cancel", async () => {
    writesFail = true;
    mount();
    await rowAction("Edit");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save dataset")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Dataset")).toBeNull());
  });

  it("Delete removes the dataset through the real hook", async () => {
    mount();
    await rowAction("Delete");
    // Deleting a dataset is irreversible, so the action opens a confirmation and
    // only the dialog's own Delete performs it.
    await screen.findByText("Delete dataset");
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    // Confirmation is name-typed, not a bare "are you sure": the dialog spells out
    // that every version's cases go with it.
    const confirm = screen.getAllByRole("button", { name: "Delete" }).at(-1)!;
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Billing routing"), {
      target: { value: "Billing routing" },
    });
    fireEvent.click(confirm);
    expect(await screen.findByText("Deleted Billing routing")).toBeDefined();
    expect(requests.some((r) => r.method === "DELETE" && r.url.endsWith("/datasets/ds1"))).toBe(
      true,
    );
  });
});
