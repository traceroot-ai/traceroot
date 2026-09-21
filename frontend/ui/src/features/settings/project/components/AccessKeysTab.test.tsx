// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImpersonationError } from "@/lib/api/errors";
import { getAccessKeys, createAccessKey, updateAccessKey, deleteAccessKey } from "@/lib/api";
import { AccessKeysTab } from "./AccessKeysTab";

vi.mock("@/lib/api", () => ({
  getAccessKeys: vi.fn(),
  createAccessKey: vi.fn(),
  updateAccessKey: vi.fn(),
  deleteAccessKey: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows the restriction instead of an empty key list", async () => {
  vi.mocked(getAccessKeys).mockRejectedValue(
    new ImpersonationError("API keys cannot be viewed while impersonating."),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  expect((await screen.findByRole("alert")).textContent).toContain("while impersonating");
  expect(screen.queryByText(/No API keys yet/)).toBeNull();
  expect(screen.queryByText("Create new API key")).toBeNull();
});

it("keeps the ordinary empty-state copy", async () => {
  vi.mocked(getAccessKeys).mockResolvedValue({ access_keys: [] });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("No API keys yet. Create one to start using the SDK."),
  ).toBeTruthy();
});

it.each(["create", "update", "delete"] as const)(
  "shows a %s denial and clears it when reopening",
  async (action) => {
    vi.mocked(getAccessKeys).mockResolvedValue({
      access_keys: [
        {
          id: "key-1",
          name: "Test key",
          key_hint: "tr-1234",
          create_time: new Date().toISOString(),
          last_use_time: null,
        },
      ],
    } as Awaited<ReturnType<typeof getAccessKeys>>);
    const api = { create: createAccessKey, update: updateAccessKey, delete: deleteAccessKey }[
      action
    ];
    vi.mocked(api).mockRejectedValue(
      new ImpersonationError("API keys cannot be managed while impersonating."),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <AccessKeysTab projectId="p" />
      </QueryClientProvider>,
    );
    await screen.findByText("Test key");
    const open = () => {
      if (action === "create") fireEvent.click(screen.getByText("Create new API key"));
      else if (action === "update") fireEvent.click(screen.getByText("Test key"));
      else fireEvent.click(within(screen.getAllByRole("row")[1]).getAllByRole("button").at(-1)!);
    };
    open();
    const dialog = within(screen.getByRole("dialog"));
    if (action === "delete")
      fireEvent.change(dialog.getByRole("textbox"), { target: { value: "Test key" } });
    fireEvent.click(
      dialog.getByRole("button", {
        name: { create: "Create", update: "Save", delete: "Delete API Key" }[action],
      }),
    );
    expect(await dialog.findByRole("alert")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    open();
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
  },
);
