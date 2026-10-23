// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { mockRetention } from "@/test/retention-mock";
const mocks = vi.hoisted(() => ({
  usersError: null as unknown,
  usersData: undefined as unknown,
  usersPending: false,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHideAiButton: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1" } }, isPending: false }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useUsers: () => ({
    data: mocks.usersData,
    isPending: mocks.usersPending,
    error: mocks.usersError,
  }),
}));

vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { dateFilter: { id: "7d" }, customStartDate: null, customEndDate: null, keyword: "" },
    queryOptions: {},
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => mockRetention(),
}));
vi.mock("@/ee/features/billing/PricingDialog", () => ({ PricingDialog: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
import UsersPage from "./page";

afterEach(() => {
  cleanup();
  mocks.usersError = null;
  mocks.usersData = undefined;
  mocks.usersPending = false;
});

describe("UsersPage", () => {
  it("renders loading state", () => {
    mocks.usersPending = true;
    render(<UsersPage />);
    expect(screen.getByText("Loading users...")).toBeTruthy();
  });

  it("shows the nav tabs and the no-users empty state", () => {
    mocks.usersData = { data: [], meta: { total: 0 } };
    render(<UsersPage />);

    expect(screen.getByText("Traces")).toBeTruthy();
    expect(screen.getByText("Users")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("No users found")).toBeTruthy();
  });
});
