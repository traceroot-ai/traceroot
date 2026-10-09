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
 *
 * The trigger label alone would not prove the gate does anything, though — a
 * relabelled button that never reaches the server is still an ungated read. So
 * every assertion also reads the window the runs request actually asked for, off
 * the mocked fetch URL's `started_after` bound.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
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
  // A fresh element per render (the same QueryClient, so the cache survives) — React
  // bails out of re-rendering a referentially identical element, which would make
  // `rerender` a no-op for the plan-resolves-after-mount test below.
  const tree = () => (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <EvaluationsView projectId="p1" />
      </ToastProvider>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, rerender: () => result.rerender(tree()) };
}

/** The view's default window in days, i.e. what a refused preset must leave behind. */
const DEFAULT_DAYS = 14;

/** Mount, open the preset popover, and click `label`. */
async function pickPreset(label: string) {
  (global.fetch as unknown as Mock).mockClear();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: DEFAULT_LABEL }));
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/**
 * Width, in days, of the window the most recent runs request asked the server
 * for — decoded from its `started_after` bound. Throws when the view has issued
 * no runs request at all, so an un-queried preset can never read as applied.
 */
function requestedWindowDays(): number {
  const urls = (global.fetch as unknown as Mock).mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes("/evaluations/runs"));
  if (urls.length === 0) throw new Error("no runs request was issued");
  const startedAfter = new URL(urls[urls.length - 1], "http://t").searchParams.get("started_after");
  if (!startedAfter) throw new Error("runs request carried no started_after bound");
  return Math.round((Date.now() - Date.parse(startedAfter)) / 86_400_000);
}

/**
 * The preset was applied: the (now closed) trigger carries its label AND the
 * runs query moved to that window.
 */
async function expectApplied(label: string, days: number) {
  expect(screen.getByText(label)).toBeTruthy();
  await waitFor(() => expect(requestedWindowDays()).toBe(days));
}

/**
 * The preset was refused: the trigger is still on the default window and the
 * runs query never widened past it.
 */
async function expectLocked(label: string) {
  expect(screen.getByText(DEFAULT_LABEL)).toBeTruthy();
  expect(screen.queryByText(label)).toBeNull();
  expect(requestedWindowDays()).toBe(DEFAULT_DAYS);
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
      await expectLocked(label);
      cleanup();
    }
  });

  it("FREE (15 days): a preset inside the window still applies", async () => {
    await pickPreset("Last 7 days");
    await expectApplied("Last 7 days", 7);
  });

  it("STARTER (30 days): 30d applies, 60d / 90d are locked", async () => {
    lookups.workspace = { data: { billingPlan: PlanType.STARTER }, isPending: false };

    await pickPreset("Last 30 days");
    await expectApplied("Last 30 days", 30);
    cleanup();

    for (const label of ["Last 60 days", "Last 90 days"]) {
      await pickPreset(label);
      await expectLocked(label);
      cleanup();
    }
  });

  it("PRO (90 days): the full window applies", async () => {
    lookups.workspace = { data: { billingPlan: PlanType.PRO }, isPending: false };

    await pickPreset("Last 90 days");
    await expectApplied("Last 90 days", 90);
  });

  it("ENTERPRISE (unlimited): nothing is locked", async () => {
    lookups.workspace = { data: { billingPlan: PlanType.ENTERPRISE }, isPending: false };

    await pickPreset("Last 90 days");
    await expectApplied("Last 90 days", 90);
  });

  it("fails closed for an unrecognized plan string (15 days)", async () => {
    lookups.workspace = { data: { billingPlan: "constructor" }, isPending: false };

    await pickPreset("Last 30 days");
    await expectLocked("Last 30 days");
  });

  it("locks nothing while the plan is still loading (retentionDays undefined)", async () => {
    // Matches the other surfaces: a hard reload must not transiently narrow the
    // range against the free plan's window before the workspace resolves.
    lookups.workspace = { data: undefined, isPending: true };

    await pickPreset("Last 90 days");
    await expectApplied("Last 90 days", 90);
  });

  it("collapses a pick made before the plan resolved once retention lands", async () => {
    // The gap above is real: nothing is locked while the workspace is in flight, so a
    // 90-day pick CAN be applied. What must not happen is the control keeping that
    // label — and that query — for the rest of the session once the plan says 15 days.
    // The server clamps either way, so this is the control telling the truth about the
    // window it is actually showing, matching clampDateFilter on the other surfaces.
    lookups.workspace = { data: undefined, isPending: true };
    (global.fetch as unknown as Mock).mockClear();
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: DEFAULT_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "Last 90 days" }));
    await expectApplied("Last 90 days", 90);

    lookups.workspace = { data: { billingPlan: PlanType.FREE }, isPending: false };
    view.rerender();

    await waitFor(() => expect(screen.getByText(DEFAULT_LABEL)).toBeTruthy());
    expect(screen.queryByText("Last 90 days")).toBeNull();
    await waitFor(() => expect(requestedWindowDays()).toBe(DEFAULT_DAYS));
  });

  it("routes a locked preset to the upgrade flow", async () => {
    await pickPreset("Last 90 days");

    expect(screen.getByText("Choose a plan")).toBeTruthy();
  });

  it("offers the upgrade flow against the free plan when the plan string is unrecognized", async () => {
    // Same fail-closed rule the window uses: an unknown `billing_plan` (a free-form
    // TEXT column) must reach the dialog as FREE. Raw, it matches no plan, so no card
    // is the current one and `isUpgrade` is false for all of them — every CTA reads
    // "Downgrade", inviting a paying-looking workspace to "downgrade" to Starter.
    lookups.workspace = { data: { billingPlan: "legacy-team" }, isPending: false };

    await pickPreset("Last 90 days");

    expect(screen.getByText("Current Plan")).toBeTruthy();
    expect(screen.queryByText("Downgrade")).toBeNull();
  });
});
