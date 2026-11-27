// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImpersonationError } from "@/lib/api/errors";
import { getAccessKeys, createAccessKey, updateAccessKey, deleteAccessKey } from "@/lib/api";
import { AccessKeysTab } from "./AccessKeysTab";

const state = vi.hoisted(() => ({
  role: "ADMIN" as "ADMIN" | "MEMBER" | "VIEWER" | undefined,
  userId: "user",
  sessionPending: false,
  sessionRefetching: false,
  sessionError: null as Error | null,
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: state.userId } },
    isPending: state.sessionPending,
    isRefetching: state.sessionRefetching,
    error: state.sessionError,
  }),
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "w" } }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: state.role ? { role: state.role } : undefined }),
}));

vi.mock("@/lib/api", () => ({
  getAccessKeys: vi.fn(),
  createAccessKey: vi.fn(),
  updateAccessKey: vi.fn(),
  deleteAccessKey: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  state.role = "ADMIN";
  state.userId = "user";
  state.sessionPending = false;
  state.sessionRefetching = false;
  state.sessionError = null;
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

it("associates the API key name field with its visible label", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create new API key" }));
  expect(within(screen.getByRole("dialog")).getByLabelText("Name (optional)")).toBeTruthy();
});

it("lets a member create a key without reading or displaying the existing inventory", async () => {
  state.role = "MEMBER";
  vi.mocked(createAccessKey).mockResolvedValue({
    data: {
      id: "new-key",
      key: "tr-created-once",
      key_hint: "tr-created",
      name: "Member integration",
      expire_time: null,
      last_use_time: null,
      create_time: "2026-01-01T00:00:00Z",
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["access-keys", "p", "user"], {
    access_keys: [{ id: "private-key", name: "Existing private key", key_hint: "tr-private-hint" }],
  });
  render(
    <QueryClientProvider client={client}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );

  expect(
    screen.getByText("Only workspace administrators can view existing API keys."),
  ).toBeTruthy();
  expect(screen.queryByText(/No API keys yet/)).toBeNull();
  expect(screen.queryByText("Existing private key")).toBeNull();
  expect(screen.queryByText(/tr-priv[.][.][.]hint/)).toBeNull();
  expect(getAccessKeys).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Create new API key" }));
  const dialog = within(screen.getByRole("dialog", { name: "Create API Key" }));
  fireEvent.change(dialog.getByLabelText("Name (optional)"), {
    target: { value: "Member integration" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Create" }));

  expect(await screen.findByText("tr-created-once")).toBeTruthy();
  expect(createAccessKey).toHaveBeenCalledWith("p", "Member integration");
  expect(getAccessKeys).not.toHaveBeenCalled();
  expect(screen.queryByText("Existing private key")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "I've copied the key" }));
  expect(screen.queryByText("tr-created-once")).toBeNull();
});

it.each(["VIEWER", undefined] as const)(
  "does not fetch or offer key creation for role %s",
  (role) => {
    state.role = role;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AccessKeysTab projectId="p" />
      </QueryClientProvider>,
    );
    expect(getAccessKeys).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Create new API key" })).toBeNull();
    expect(screen.queryByText(/No API keys yet/)).toBeNull();
  },
);

it("does not render another account's cached key inventory", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  const privateInventory = {
    access_keys: [{ id: "private-key", name: "Previous account key", key_hint: "tr-private-hint" }],
  };
  client.setQueryData(["access-keys", "p"], privateInventory);
  client.setQueryData(["access-keys", "p", "previous-user"], privateInventory);
  vi.mocked(getAccessKeys).mockRejectedValue(new Error("Connection unavailable"));
  render(
    <QueryClientProvider client={client}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  expect(screen.queryByText("Previous account key")).toBeNull();
  expect(screen.queryByText(/tr-priv[.][.][.]hint/)).toBeNull();
  await waitFor(() =>
    expect(client.getQueryState(["access-keys", "p", "user"])?.status).toBe("error"),
  );
  expect(screen.queryByText("Previous account key")).toBeNull();
  expect(getAccessKeys).toHaveBeenCalled();
});

it.each(["sessionPending", "sessionRefetching"] as const)(
  "waits for identity during %s even when an administrator membership is cached",
  (flag) => {
    state[flag] = true;
    const client = new QueryClient();
    client.setQueryData(["access-keys", "p", "user"], {
      access_keys: [
        { id: "private-key", name: "Pending session key", key_hint: "tr-private-hint" },
      ],
    });
    render(
      <QueryClientProvider client={client}>
        <AccessKeysTab projectId="p" />
      </QueryClientProvider>,
    );
    expect(screen.queryByText("Pending session key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create new API key" })).toBeNull();
    expect(getAccessKeys).not.toHaveBeenCalled();
  },
);

it("does not trust administrator data after the session request fails", () => {
  state.sessionError = new Error("Session unavailable");
  const client = new QueryClient();
  client.setQueryData(["access-keys", "p", "user"], {
    access_keys: [{ id: "private-key", name: "Previous session key", key_hint: "tr-private-hint" }],
  });
  render(
    <QueryClientProvider client={client}>
      <AccessKeysTab projectId="p" />
    </QueryClientProvider>,
  );
  expect(screen.queryByText("Previous session key")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create new API key" })).toBeNull();
  expect(getAccessKeys).not.toHaveBeenCalled();
});

const oneTimeResponse = {
  data: {
    id: "new-key",
    key: "tr-identity-owned-secret",
    key_hint: "tr-owned",
    name: "Created integration",
    expire_time: null,
    last_use_time: null,
    create_time: "2026-01-01T00:00:00Z",
  },
};

function keyView(client: QueryClient, projectId = "p") {
  return (
    <QueryClientProvider client={client}>
      <AccessKeysTab projectId={projectId} />
    </QueryClientProvider>
  );
}

function submitNewKey() {
  fireEvent.click(screen.getByRole("button", { name: "Create new API key" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));
}

it.each(["sessionPending", "sessionRefetching", "sessionError", "account", "project"] as const)(
  "hides both one-time secret render paths after a change in %s",
  async (change) => {
    state.role = "MEMBER";
    vi.mocked(createAccessKey).mockResolvedValue(oneTimeResponse);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(keyView(client));
    submitNewKey();
    expect(await screen.findByText(oneTimeResponse.data.key)).toBeTruthy();
    expect(document.body.textContent).toContain(`TRACEROOT_API_KEY="${oneTimeResponse.data.key}"`);

    if (change === "sessionError") state.sessionError = new Error("Session unavailable");
    else if (change === "account") state.userId = "another-user";
    else if (change !== "project") state[change] = true;
    rerender(keyView(client, change === "project" ? "another-project" : "p"));

    expect(document.body.textContent).not.toContain(oneTimeResponse.data.key);
    expect(screen.queryByRole("button", { name: "Copy API key" })).toBeNull();
  },
);

it.each(["account", "project"] as const)(
  "does not display a late creation response after switching %s",
  async (change) => {
    state.role = "MEMBER";
    let complete!: (response: typeof oneTimeResponse) => void;
    vi.mocked(createAccessKey).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(keyView(client));
    submitNewKey();
    await waitFor(() => expect(createAccessKey).toHaveBeenCalledWith("p", undefined));
    if (change === "account") state.userId = "another-user";
    rerender(keyView(client, change === "project" ? "another-project" : "p"));
    await act(async () => complete(oneTimeResponse));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(oneTimeResponse.data.key);
  },
);
