// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

it.each([
  ["Production", "Delete API key Production"],
  [null, "Delete API key tr-1234...9012"],
])("names the delete action for API key %s", async (name, expectedLabel) => {
  vi.mocked(getAccessKeys).mockResolvedValue({
    access_keys: [
      {
        id: "key-1",
        name,
        key_hint: "tr-123456789012",
        create_time: "2026-01-01T00:00:00Z",
        last_use_time: null,
      },
    ],
  } as Awaited<ReturnType<typeof getAccessKeys>>);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  const button = await screen.findByRole("button", { name: expectedLabel });
  expect(button.title).toBe(expectedLabel);
  fireEvent.click(button);
  expect(screen.getByRole("dialog", { name: "Delete API Key" })).toBeTruthy();
  expect(deleteAccessKey).not.toHaveBeenCalled();
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

it("does not create an API key while confirming an IME candidate", async () => {
  vi.mocked(getAccessKeys).mockResolvedValue({ access_keys: [] });
  vi.mocked(createAccessKey).mockResolvedValue({
    data: {
      id: "key-1",
      key: "tr-secret",
      key_hint: "tr-secret",
      name: "Production",
      expire_time: null,
      last_use_time: null,
      create_time: "2026-01-01T00:00:00Z",
    },
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Create new API key" }));
  const input = within(screen.getByRole("dialog")).getByLabelText("Name (optional)");
  fireEvent.change(input, { target: { value: "Production" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(createAccessKey).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(createAccessKey).toHaveBeenCalledWith("p", "Production"));
});

it("does not save an API key note while confirming an IME candidate", async () => {
  vi.mocked(getAccessKeys).mockResolvedValue({
    access_keys: [
      {
        id: "key-1",
        name: "Production",
        key_hint: "tr-1234",
        expire_time: null,
        create_time: "2026-01-01T00:00:00Z",
        last_use_time: null,
      },
    ],
  } as Awaited<ReturnType<typeof getAccessKeys>>);
  vi.mocked(updateAccessKey).mockResolvedValue({
    id: "key-1",
    name: "Production",
    key_hint: "tr-1234",
    expire_time: null,
    create_time: "2026-01-01T00:00:00Z",
    last_use_time: null,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByText("Production"));
  const input = within(screen.getByRole("dialog")).getByLabelText("Note");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(updateAccessKey).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(updateAccessKey).toHaveBeenCalledWith("p", "key-1", "Production"));
});

it("associates the API key name field with its visible label", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create new API key" }));
  expect(within(screen.getByRole("dialog")).getByLabelText("Name (optional)")).toBeTruthy();
});
