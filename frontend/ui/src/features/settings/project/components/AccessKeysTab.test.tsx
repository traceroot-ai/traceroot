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

    const copyExample = screen.getByRole("button", {
      name: /create a new api key to copy the full environment variable/i,
    });
    expect(copyExample).toHaveProperty("disabled", true);
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

    const copyMaskedHint = screen.getByRole("button", {
      name: /create a new api key to copy the full environment variable/i,
    });
    expect(copyMaskedHint).toHaveProperty("disabled", true);
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

    await act(async () => {
      deferredCreate.resolve(createResult);
      await deferredCreate.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText('TRACEROOT_API_KEY = "tr-project-one-pending-secret"')).toBeNull();
    });
    expect(screen.getByText(".env example")).toBeDefined();

    const copyEnv = screen.getByRole("button", {
      name: /create a new api key to copy the full environment variable/i,
    });
    expect(copyEnv).toHaveProperty("disabled", true);
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });
});
