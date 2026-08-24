// @vitest-environment jsdom
/**
 * The Evaluations date-range control is plan-gated like every other telemetry
 * surface: presets wider than the workspace's retention window render locked and
 * route to the upgrade flow instead of applying.
 *
 * date-filter.test.ts covers `isOptionLocked`'s plan matrix and
 * date-filter-select.test.tsx covers the control's locked-click behavior — both
 * in isolation, so neither can see whether this view actually *passes*
 * `retentionDays`. That wiring is the whole defect, so it is asserted here by
 * mounting the real view over the real `useRetention` (only the two lookups it
 * reads are stubbed), and observing the trigger label: an applied preset renames
 * the button, a locked one leaves it on the 14-day default.
 *
 * The label is matched by text rather than by role: a locked click opens the
 * (modal) PricingDialog, which `aria-hidden`s the page behind it, so a role query
 * can no longer see the trigger it is meant to assert on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { PlanType } from "@traceroot/core";

const lookups = vi.hoisted(() => ({
  project: {
    data: { workspace_id: "w1" } as { workspace_id?: string } | undefined,
    isPending: false,
  },
  workspace: {
    data: { billingPlan: "free" } as { billingPlan?: string } | undefined,
    isPending: false,
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/evaluations",
}));
// ProjectBreadcrumb pulls layout/workspace context this harness doesn't mount.
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
// `useRetention` itself stays real — it is the thing whose output must reach the
// control — so only its two data lookups are replaced.
vi.mock("@/features/projects/hooks", () => ({ useProject: () => lookups.project }));
vi.mock("@/features/workspaces/hooks", () => ({ useWorkspace: () => lookups.workspace }));

import { EvaluationsView } from "./views/evaluations-view";

/** The view's own default window (RunsTab seeds `dateFilter` to 14d). */
const DEFAULT_LABEL = "Last 14 days";

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <EvaluationsView projectId="p1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Mount, open the preset popover, and click `label`. */
async function pickPreset(label: string) {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: DEFAULT_LABEL }));
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/** The preset was applied: the (now closed) trigger carries its label. */
function expectApplied(label: string) {
  expect(screen.getByText(label)).toBeTruthy();
}

/** The preset was refused: the trigger is still on the default window. */
function expectLocked(label: string) {
  expect(screen.getByText(DEFAULT_LABEL)).toBeTruthy();
  expect(screen.queryByText(label)).toBeNull();
}

beforeEach(() => {
  lookups.project = { data: { workspace_id: "w1" }, isPending: false };
  lookups.workspace = { data: { billingPlan: PlanType.FREE }, isPending: false };
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
  })) as unknown as typeof fetch;
});
afterEach(cleanup);

describe("Evaluations date range is gated by the plan's retention window", () => {
  it("FREE (15 days): 30d / 60d / 90d are locked", async () => {
    for (const label of ["Last 30 days", "Last 60 days", "Last 90 days"]) {
      await pickPreset(label);
      expectLocked(label);
      cleanup();
    }
  });

  it("FREE (15 days): a preset inside the window still applies", async () => {
    await pickPreset("Last 7 days");
    expectApplied("Last 7 days");
  });

  it("STARTER (30 days): 30d applies, 60d / 90d are locked", async () => {
    lookups.workspace = { data: { billingPlan: PlanType.STARTER }, isPending: false };

    await pickPreset("Last 30 days");
    expectApplied("Last 30 days");
    cleanup();

    for (const label of ["Last 60 days", "Last 90 days"]) {
      await pickPreset(label);
      expectLocked(label);
      cleanup();
    }
  });

  it("PRO (90 days): the full window applies", async () => {
    lookups.workspace = { data: { billingPlan: PlanType.PRO }, isPending: false };

    await pickPreset("Last 90 days");
    expectApplied("Last 90 days");
  });

  it("ENTERPRISE (unlimited): nothing is locked", async () => {
    lookups.workspace = { data: { billingPlan: PlanType.ENTERPRISE }, isPending: false };

    await pickPreset("Last 90 days");
    expectApplied("Last 90 days");
  });

  it("fails closed for an unrecognized plan string (15 days)", async () => {
    lookups.workspace = { data: { billingPlan: "constructor" }, isPending: false };

    await pickPreset("Last 30 days");
    expectLocked("Last 30 days");
  });

  it("locks nothing while the plan is still loading (retentionDays undefined)", async () => {
    // Matches the other surfaces: a hard reload must not transiently narrow the
    // range against the free plan's window before the workspace resolves.
    lookups.workspace = { data: undefined, isPending: true };

    await pickPreset("Last 90 days");
    expectApplied("Last 90 days");
  });

  it("routes a locked preset to the upgrade flow", async () => {
    await pickPreset("Last 90 days");

    expect(screen.getByText("Choose a plan")).toBeTruthy();
  });
});
