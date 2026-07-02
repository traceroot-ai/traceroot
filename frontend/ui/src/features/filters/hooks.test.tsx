// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFilterFields, useFilterValues } from "./hooks";
import { STATIC_FILTER_FIELDS } from "./registry";
import { getFilterValues } from "@/lib/api/traces";

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "e@x.com" } }, isPending: false }),
}));
vi.mock("@/lib/api/traces", () => ({
  getFilterFields: vi.fn().mockResolvedValue({
    fields: [
      {
        field: "x",
        label: "X",
        type: "categorical",
        level: "SPAN_MEMBERSHIP",
        operators: ["in"],
        value_source: "static_enum",
        enum_values: [],
      },
    ],
  }),
  getFilterValues: vi.fn().mockResolvedValue({
    field: "model_name",
    values: [{ value: "gpt-4", count: 2 }],
  }),
}));

afterEach(cleanup);

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function FieldsProbe() {
  const fields = useFilterFields("p1");
  return <div data-testid="fields">{fields.map((f) => f.field).join(",")}</div>;
}

function ValuesProbe({
  enabled,
  startAfter,
  endBefore,
}: {
  enabled: boolean;
  startAfter?: string;
  endBefore?: string;
}) {
  const { values } = useFilterValues("p1", "model_name", startAfter, endBefore, enabled);
  return <div data-testid="values">{values.map((v) => v.value).join(",")}</div>;
}

describe("useFilterFields", () => {
  it("starts with the static fallback then swaps in the fetched registry", async () => {
    render(<FieldsProbe />, { wrapper: wrapper() });
    // Synchronous first render shows the static fallback.
    expect(screen.getByTestId("fields").textContent).toBe(
      STATIC_FILTER_FIELDS.map((f) => f.field).join(","),
    );
    await waitFor(() => expect(screen.getByTestId("fields").textContent).toBe("x"));
  });
});

describe("useFilterValues", () => {
  it("returns fetched distinct values when enabled", async () => {
    render(<ValuesProbe enabled />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByTestId("values").textContent).toBe("gpt-4"));
  });

  it("stays empty while disabled (lazy until the field is picked)", () => {
    render(<ValuesProbe enabled={false} />, { wrapper: wrapper() });
    expect(screen.getByTestId("values").textContent).toBe("");
  });

  it("passes both window bounds to the distinct-values request", async () => {
    render(
      <ValuesProbe enabled startAfter="2026-06-01T00:00:00Z" endBefore="2026-06-02T00:00:00Z" />,
      {
        wrapper: wrapper(),
      },
    );
    await waitFor(() =>
      expect(getFilterValues).toHaveBeenCalledWith(
        "p1",
        "model_name",
        "2026-06-01T00:00:00Z",
        "2026-06-02T00:00:00Z",
        expect.anything(),
      ),
    );
  });
});
