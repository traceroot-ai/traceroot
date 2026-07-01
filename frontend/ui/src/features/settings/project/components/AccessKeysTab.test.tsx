// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  getAccessKeys: vi.fn().mockResolvedValue({ access_keys: [] }),
  createAccessKey: vi.fn(),
  updateAccessKey: vi.fn(),
  deleteAccessKey: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getAccessKeys: (...args: unknown[]) => mocks.getAccessKeys(...args),
  createAccessKey: (...args: unknown[]) => mocks.createAccessKey(...args),
  updateAccessKey: (...args: unknown[]) => mocks.updateAccessKey(...args),
  deleteAccessKey: (...args: unknown[]) => mocks.deleteAccessKey(...args),
}));

import { AccessKeysTab } from "./AccessKeysTab";

const clipboardWriteText = vi.fn();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function renderAccessKeysTab(projectId = "proj_123") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <AccessKeysTab projectId={projectId} />
    </QueryClientProvider>,
  );

  return {
    ...renderResult,
    rerenderWithProject(nextProjectId: string) {
      renderResult.rerender(
        <QueryClientProvider client={queryClient}>
          <AccessKeysTab projectId={nextProjectId} />
        </QueryClientProvider>,
      );
    },
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
  clipboardWriteText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  mocks.getAccessKeys.mockReset().mockResolvedValue({ access_keys: [] });
  mocks.createAccessKey.mockReset();
  mocks.updateAccessKey.mockReset();
  mocks.deleteAccessKey.mockReset();
  clipboardWriteText.mockReset();
});

describe("AccessKeysTab", () => {
  it("shows Project API Keys help from the info icon", async () => {
    renderAccessKeysTab();

    const trigger = screen.getByRole("button", { name: /about project api keys/i });
    expect(trigger).toBeDefined();

    fireEvent.focus(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/authenticate traceroot sdk and api requests/i);
    expect(tooltip.textContent).toMatch(/copy the full secret immediately/i);
    expect(tooltip.textContent).toMatch(/store it as traceroot_api_key/i);
    expect(tooltip.textContent).toMatch(/only a masked hint is shown/i);
  });

  it("renders a disabled example environment variable when there are no API keys", async () => {
    renderAccessKeysTab();

    expect(await screen.findByText(".env example")).toBeDefined();
    expect(screen.getByText('TRACEROOT_API_KEY = "tr-..."')).toBeDefined();

    expect(screen.queryByRole("button", { name: /copy api key environment variable/i })).toBeNull();
  });

  it("does not offer to copy masked API key hints as usable secrets", async () => {
    mocks.getAccessKeys.mockResolvedValue({
      access_keys: [
        {
          id: "key_123",
          key_hint: "tr-1234567890abcdef",
          name: "Production",
          expire_time: null,
          last_use_time: null,
          create_time: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    renderAccessKeysTab();

    expect(await screen.findByText(".env masked hint")).toBeDefined();
    expect(
      screen.getByText(/create a new api key to copy a full traceroot_api_key value/i),
    ).toBeDefined();

    expect(screen.queryByRole("button", { name: /copy api key environment variable/i })).toBeNull();
  });

  it("closes project-scoped edit and delete dialogs when the project changes", async () => {
    mocks.getAccessKeys.mockResolvedValue({
      access_keys: [
        {
          id: "key_123",
          key_hint: "tr-1234567890abcdef",
          name: "Production",
          expire_time: null,
          last_use_time: null,
          create_time: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    const { rerenderWithProject } = renderAccessKeysTab("proj_123");

    fireEvent.click(await screen.findByRole("button", { name: "Production" }));
    expect(screen.getByText("Edit Note")).toBeDefined();

    rerenderWithProject("proj_456");

    await waitFor(() => {
      expect(screen.queryByText("Edit Note")).toBeNull();
    });
    await screen.findByRole("button", { name: "Production" });

    fireEvent.click(screen.getByRole("button", { name: /delete api key/i }));
    expect(screen.getAllByText("Delete API Key").length).toBeGreaterThan(0);

    rerenderWithProject("proj_789");

    await waitFor(() => {
      expect(screen.queryByText("Delete API Key")).toBeNull();
    });
  });

  it("copies the full environment variable only after a new key is created", async () => {
    mocks.createAccessKey.mockResolvedValue({
      data: {
        key: "tr-full-secret-value",
        key_hint: "tr-full...alue",
      },
    });

    renderAccessKeysTab();

    fireEvent.click(screen.getByRole("button", { name: /create new api key/i }));
    fireEvent.change(screen.getByPlaceholderText(/production, development/i), {
      target: { value: "Production" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText(".env")).toBeDefined();
    expect(screen.getByText('TRACEROOT_API_KEY = "tr-full-secret-value"')).toBeDefined();

    const copyEnv = screen.getByRole("button", { name: /copy api key environment variable/i });
    expect(copyEnv).toHaveProperty("disabled", false);

    fireEvent.click(copyEnv);

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('TRACEROOT_API_KEY = "tr-full-secret-value"');
    });
  });

  it("clears the one-time secret after the user confirms it was copied", async () => {
    mocks.createAccessKey.mockResolvedValue({
      data: {
        key: "tr-dismissed-secret-value",
        key_hint: "tr-dism...alue",
      },
    });

    renderAccessKeysTab();

    fireEvent.click(screen.getByRole("button", { name: /create new api key/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(
      await screen.findByText('TRACEROOT_API_KEY = "tr-dismissed-secret-value"'),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /i've copied the key/i }));

    await waitFor(() => {
      expect(screen.queryByText('TRACEROOT_API_KEY = "tr-dismissed-secret-value"')).toBeNull();
    });
    expect(screen.getByText(".env example")).toBeDefined();
    expect(screen.getByText('TRACEROOT_API_KEY = "tr-..."')).toBeDefined();
  });

  it("does not carry a one-time secret across project changes", async () => {
    mocks.createAccessKey.mockResolvedValue({
      data: {
        key: "tr-project-one-secret",
        key_hint: "tr-proj...cret",
      },
    });

    const { rerenderWithProject } = renderAccessKeysTab("proj_123");

    fireEvent.click(screen.getByRole("button", { name: /create new api key/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText('TRACEROOT_API_KEY = "tr-project-one-secret"')).toBeDefined();

    rerenderWithProject("proj_456");

    await waitFor(() => {
      expect(screen.queryByText('TRACEROOT_API_KEY = "tr-project-one-secret"')).toBeNull();
    });
    expect(screen.getByText(".env example")).toBeDefined();
    expect(screen.getByText('TRACEROOT_API_KEY = "tr-..."')).toBeDefined();
  });

  it("ignores in-flight key creation that resolves after switching projects", async () => {
    const createResult = {
      data: {
        key: "tr-project-one-pending-secret",
        key_hint: "tr-pend...cret",
      },
    };
    const deferredCreate = createDeferred<typeof createResult>();
    mocks.createAccessKey.mockReturnValue(deferredCreate.promise);

    const { rerenderWithProject } = renderAccessKeysTab("proj_123");

    fireEvent.click(screen.getByRole("button", { name: /create new api key/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mocks.createAccessKey).toHaveBeenCalledWith("proj_123", undefined);
    });

    rerenderWithProject("proj_456");

    fireEvent.click(screen.getByRole("button", { name: /create new api key/i }));
    expect(screen.getByRole("button", { name: /^create$/i })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await act(async () => {
      deferredCreate.resolve(createResult);
      await deferredCreate.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText('TRACEROOT_API_KEY = "tr-project-one-pending-secret"')).toBeNull();
    });
    expect(screen.getByText(".env example")).toBeDefined();

    expect(screen.queryByRole("button", { name: /copy api key environment variable/i })).toBeNull();
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("does not submit duplicate creates with Enter while a create is pending", async () => {
    const createResult = {
      data: {
        key: "tr-pending-secret",
        key_hint: "tr-pend...cret",
      },
    };
    const deferredCreate = createDeferred<typeof createResult>();
    mocks.createAccessKey.mockReturnValue(deferredCreate.promise);

    renderAccessKeysTab();

    fireEvent.click(screen.getByRole("button", { name: /create new api key/i }));

    const nameInput = screen.getByPlaceholderText(/production, development/i);
    fireEvent.keyDown(nameInput, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mocks.createAccessKey).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole("button", { name: /creating/i })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.keyDown(nameInput, { key: "Enter", code: "Enter" });

    expect(mocks.createAccessKey).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferredCreate.resolve(createResult);
      await deferredCreate.promise;
    });
  });

  it("keeps the active create pending when an older project create resolves first", async () => {
    const projectOneResult = {
      data: {
        key: "tr-project-one-stale-secret",
        key_hint: "tr-stal...cret",
      },
    };
    const projectTwoResult = {
      data: {
        key: "tr-project-two-active-secret",
        key_hint: "tr-acti...cret",
      },
    };
    const projectOneCreate = createDeferred<typeof projectOneResult>();
    const projectTwoCreate = createDeferred<typeof projectTwoResult>();
    mocks.createAccessKey
      .mockReturnValueOnce(projectOneCreate.promise)
      .mockReturnValueOnce(projectTwoCreate.promise);

    const { rerenderWithProject } = renderAccessKeysTab("proj_123");

    fireEvent.click(screen.getByRole("button", { name: /create new api key/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mocks.createAccessKey).toHaveBeenCalledWith("proj_123", undefined);
    });

    rerenderWithProject("proj_456");

    fireEvent.click(screen.getByRole("button", { name: /create new api key/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mocks.createAccessKey).toHaveBeenCalledWith("proj_456", undefined);
    });
    expect(await screen.findByRole("button", { name: /creating/i })).toHaveProperty(
      "disabled",
      true,
    );

    await act(async () => {
      projectOneCreate.resolve(projectOneResult);
      await projectOneCreate.promise;
    });

    expect(screen.queryByText('TRACEROOT_API_KEY = "tr-project-one-stale-secret"')).toBeNull();
    expect(screen.getByRole("button", { name: /creating/i })).toHaveProperty("disabled", true);

    await act(async () => {
      projectTwoCreate.resolve(projectTwoResult);
      await projectTwoCreate.promise;
    });

    expect(
      await screen.findByText('TRACEROOT_API_KEY = "tr-project-two-active-secret"'),
    ).toBeDefined();
    expect(screen.queryByText('TRACEROOT_API_KEY = "tr-project-one-stale-secret"')).toBeNull();
  });

  it("does not let an in-flight note update close the next project's edit dialog", async () => {
    mocks.getAccessKeys.mockResolvedValue({
      access_keys: [
        {
          id: "key_123",
          key_hint: "tr-1234567890abcdef",
          name: "Production",
          expire_time: null,
          last_use_time: null,
          create_time: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const deferredUpdate = createDeferred<void>();
    mocks.updateAccessKey.mockReturnValue(deferredUpdate.promise);

    const { rerenderWithProject } = renderAccessKeysTab("proj_123");

    fireEvent.click(await screen.findByRole("button", { name: "Production" }));
    fireEvent.change(screen.getByPlaceholderText(/production, development/i), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(mocks.updateAccessKey).toHaveBeenCalledWith("proj_123", "key_123", "Renamed");
    });

    rerenderWithProject("proj_456");

    await waitFor(() => {
      expect(screen.queryByText("Edit Note")).toBeNull();
    });

    fireEvent.click(await screen.findByRole("button", { name: "Production" }));
    expect(screen.getByRole("button", { name: /^save$/i })).toHaveProperty("disabled", false);

    await act(async () => {
      deferredUpdate.resolve();
      await deferredUpdate.promise;
    });

    expect(screen.getByText("Edit Note")).toBeDefined();
  });

  it("does not let an in-flight delete close the next project's delete dialog", async () => {
    mocks.getAccessKeys.mockResolvedValue({
      access_keys: [
        {
          id: "key_123",
          key_hint: "tr-1234567890abcdef",
          name: "Production",
          expire_time: null,
          last_use_time: null,
          create_time: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const deferredDelete = createDeferred<void>();
    mocks.deleteAccessKey.mockReturnValue(deferredDelete.promise);

    const { rerenderWithProject } = renderAccessKeysTab("proj_123");

    fireEvent.click(await screen.findByRole("button", { name: "Delete API key" }));
    fireEvent.change(screen.getByPlaceholderText("API key name"), {
      target: { value: "Production" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete API Key" }));

    await waitFor(() => {
      expect(mocks.deleteAccessKey).toHaveBeenCalledWith("proj_123", "key_123");
    });

    rerenderWithProject("proj_456");

    await waitFor(() => {
      expect(screen.queryByText("Delete API Key")).toBeNull();
    });

    fireEvent.click(await screen.findByRole("button", { name: "Delete API key" }));
    fireEvent.change(screen.getByPlaceholderText("API key name"), {
      target: { value: "Production" },
    });
    expect(screen.getByRole("button", { name: "Delete API Key" })).toHaveProperty(
      "disabled",
      false,
    );

    await act(async () => {
      deferredDelete.resolve();
      await deferredDelete.promise;
    });

    expect(screen.getByRole("heading", { name: "Delete API Key" })).toBeDefined();
  });
});
