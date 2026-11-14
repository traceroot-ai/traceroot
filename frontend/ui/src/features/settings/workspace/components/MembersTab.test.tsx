// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInvite, updateMemberRole } from "@/lib/api";
import { MembersTab } from "./MembersTab";

vi.mock("@/lib/api", () => ({
  getWorkspace: vi.fn(),
  getMembers: vi.fn(),
  getInvites: vi.fn(),
  createInvite: vi.fn(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
  cancelInvite: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "admin-1" } } }),
}));

function openDialog(kind: "invite" | "role") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["workspace", "w1"], { role: "ADMIN" });
  queryClient.setQueryData(
    ["members", "w1"],
    [
      {
        id: "m1",
        user_id: "u1",
        name: "Team member",
        email: "member@example.com",
        role: "MEMBER",
      },
    ],
  );
  queryClient.setQueryData(["invites", "w1"], []);

  render(
    <QueryClientProvider client={queryClient}>
      <MembersTab workspaceId="w1" />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: kind === "invite" ? "Invite member" : "Member" }),
  );
  const dialog = within(screen.getByRole("dialog"));
  if (kind === "invite") {
    fireEvent.change(dialog.getByPlaceholderText("member@example.com"), {
      target: { value: "invite@example.com" },
    });
  }
  return dialog;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("MembersTab Cancel actions", () => {
  it.each(["invite", "role"] as const)("closes the %s dialog without submitting", async (kind) => {
    const dialog = openDialog(kind);
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createInvite).not.toHaveBeenCalled();
    expect(updateMemberRole).not.toHaveBeenCalled();
  });

  it.each(["invite", "role"] as const)(
    "disables Cancel while the %s request is pending",
    async (kind) => {
      if (kind === "invite") {
        vi.mocked(createInvite).mockReturnValue(new Promise(() => {}));
      } else {
        vi.mocked(updateMemberRole).mockReturnValue(new Promise(() => {}));
      }
      const dialog = openDialog(kind);
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      expect(cancel).toHaveProperty("disabled", false);
      fireEvent.click(
        dialog.getByRole("button", { name: kind === "invite" ? "Send Invitation" : "Save" }),
      );

      await waitFor(() => expect(cancel).toHaveProperty("disabled", true));
      expect(kind === "invite" ? createInvite : updateMemberRole).toHaveBeenCalledTimes(1);
    },
  );
});
