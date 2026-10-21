// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ADAPTER_CONFIG, ADAPTER_MODELS, type LLMAdapter } from "@traceroot/core";

const mocks = vi.hoisted(() => ({
  getModelProviders: vi.fn(),
  createModelProvider: vi.fn(),
  testModelProvider: vi.fn(),
  workspace: {
    data: undefined as { role: string } | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock("@/lib/api", () => ({
  getModelProviders: mocks.getModelProviders,
  createModelProvider: mocks.createModelProvider,
  testModelProvider: mocks.testModelProvider,
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => mocks.workspace,
}));

// The house pattern for next/link in jsdom, with a marker attribute so a
// regression to a plain <a> is visible to the assertions that check these
// links route through the app.
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) => (
    <a data-nextlink="" {...props}>
      {children}
    </a>
  ),
}));

// Radix Select renders through a portal and is flaky in jsdom; mock it to a
// native <select> so the adapter choice can be driven directly, matching the
// pattern used in ModelProvidersTab.test.tsx.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Model provider"
      role="combobox"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { ApiError } from "@/lib/api/errors";
import standardPrices from "../../../../../../packages/core/src/standard-model-prices.json";
import {
  INLINE_ADAPTERS,
  isInlineConfigurable,
  ModelProviderBlock,
  SEEDED_MODELS,
  SETTINGS_ONLY_ADAPTERS,
} from "./ModelProviderBlock";

function renderBlock(workspaceId = "ws-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ModelProviderBlock workspaceId={workspaceId} />
      </QueryClientProvider>,
    ),
  };
}

async function fillKey(value = "sk-test-key") {
  const field = await screen.findByLabelText("API key");
  fireEvent.change(field, { target: { value } });
  return field as HTMLInputElement;
}

beforeEach(() => {
  mocks.getModelProviders.mockResolvedValue({ byokEnabled: true, providers: [] });
  mocks.testModelProvider.mockResolvedValue({ success: true });
  mocks.createModelProvider.mockResolvedValue({ id: "mp-1" });
  mocks.workspace.data = { role: "ADMIN" };
  mocks.workspace.isLoading = false;
  mocks.workspace.isError = false;
});

afterEach(() => {
  cleanup();
  mocks.getModelProviders.mockReset();
  mocks.createModelProvider.mockReset();
  mocks.testModelProvider.mockReset();
});

describe("the adapters offered inline", () => {
  it("offers exactly the adapters a single pasted key fully configures", () => {
    // Taken across PROVIDER_PRIORITY, not ADAPTER_CONFIG's keys: the latter also
    // holds the internal `typesafe` decision adapter, which would wrongly make
    // this eight.
    expect(INLINE_ADAPTERS).toEqual([
      "anthropic",
      "openai",
      "deepseek",
      "xai",
      "moonshot",
      "zai",
      "google",
    ]);
    expect(SETTINGS_ONLY_ADAPTERS).toEqual(["openrouter", "azure", "amazon-bedrock"]);
    expect(INLINE_ADAPTERS).not.toContain("typesafe");
  });

  it("keeps out an adapter whose key is not the whole credential, catalogue or not", () => {
    // Today's tables exclude Azure, Bedrock and OpenRouter on both halves of
    // the rule at once, so the concrete list above cannot tell the halves
    // apart. Each clause is pinned here instead, against entries the tables do
    // not have yet.
    const catalogue = [{ id: "a-model" }];
    expect(
      isInlineConfigurable({ credentialType: "api-key", requiresBaseUrl: true }, catalogue),
    ).toBe(false);
    expect(isInlineConfigurable({ credentialType: "aws", requiresBaseUrl: false }, catalogue)).toBe(
      false,
    );
    expect(isInlineConfigurable({ credentialType: "api-key", requiresBaseUrl: false }, [])).toBe(
      false,
    );
    expect(isInlineConfigurable(undefined, catalogue)).toBe(false);
    expect(
      isInlineConfigurable({ credentialType: "api-key", requiresBaseUrl: false }, catalogue),
    ).toBe(true);
  });

  it("asks for the provider rather than inferring it, defaulting to the top-ranked one", async () => {
    renderBlock();
    const select = (await screen.findByLabelText("Model provider")) as HTMLSelectElement;
    expect(select.value).toBe("anthropic");
    expect([...select.options].map((o) => o.value)).toEqual(INLINE_ADAPTERS);
  });

  it("names the adapters that stay in settings", async () => {
    renderBlock();
    const labels = SETTINGS_ONLY_ADAPTERS.map((a: LLMAdapter) => ADAPTER_CONFIG[a].label);
    const note = await screen.findByText(/add those in workspace settings/);
    for (const label of labels) {
      expect(note.textContent).toContain(label);
    }
  });

  it("gives each of them the reason it is actually excluded for", async () => {
    renderBlock();
    const note = await screen.findByText(/add those in workspace settings/);

    // A base URL, and an access-key pair or a default-credentials toggle plus a
    // region, really are more than a key.
    expect(note.textContent).toContain(
      `${ADAPTER_CONFIG.azure.label} and ${ADAPTER_CONFIG["amazon-bedrock"].label} need more than a key`,
    );
    // OpenRouter's key is its whole credential — api-key, no base URL. It is
    // excluded only for shipping no curated catalogue, so claiming it needs
    // more than a key is false.
    expect(ADAPTER_CONFIG.openrouter.credentialType).toBe("api-key");
    expect(ADAPTER_CONFIG.openrouter.requiresBaseUrl).toBe(false);
    expect(note.textContent).toContain(
      `${ADAPTER_CONFIG.openrouter.label} needs a model list chosen`,
    );
    expect(note.textContent).not.toMatch(
      new RegExp(`${ADAPTER_CONFIG.openrouter.label}[^—]*more than a key`),
    );
  });
});

describe("probe before store", () => {
  it("does not write until the probe has answered", async () => {
    // A hand-resolved probe: while it is in flight the create must not have
    // happened at all. Asserting call order after both settle would pass even
    // if the two were fired together.
    let releaseProbe: (result: { success: boolean }) => void = () => {};
    mocks.testModelProvider.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        releaseProbe = resolve;
      }),
    );

    renderBlock();
    await fillKey();
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    await waitFor(() => expect(mocks.testModelProvider).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Verifying..." })).toBeTruthy();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();

    releaseProbe({ success: true });
    await waitFor(() => expect(mocks.createModelProvider).toHaveBeenCalledTimes(1));
  });

  it("stores nothing, shows the provider's own error and keeps the key on a failed probe", async () => {
    mocks.testModelProvider.mockResolvedValue({
      success: false,
      error: "Invalid API key",
      detail: "HTTP 401: Unauthorized",
    });

    renderBlock();
    const field = await fillKey("sk-wrong");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    expect(await screen.findByText(/Invalid API key/)).toBeTruthy();
    expect(screen.getByText(/HTTP 401: Unauthorized/)).toBeTruthy();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
    expect(field.value).toBe("sk-wrong");
  });
});

describe("the models a saved key starts with", () => {
  /**
   * Whether usage on `id` has a price: an entry that matches it by name or by
   * its `matchPattern`, and charges something. An entry whose rates are all zero
   * prices the usage at $0 as surely as no entry does.
   */
  function priced(id: string): boolean {
    return standardPrices.some(
      (entry) =>
        Object.values(entry.prices).some((rate) => typeof rate === "number" && rate > 0) &&
        (entry.modelName === id ||
          (entry.matchPattern !== "" &&
            new RegExp(entry.matchPattern.replace(/^\(\?i\)/, ""), "i").test(id))),
    );
  }

  it.each(INLINE_ADAPTERS)("seeds a few catalogue models for %s, every one priced", (adapter) => {
    // `customModels` is what the assistant and detector pickers offer, and a
    // model with no standard price is priced at $0 there. The whole catalogue
    // carried ids like that.
    const seeded = SEEDED_MODELS[adapter] ?? [];
    const catalogue = (ADAPTER_MODELS[adapter] ?? []).map((m) => m.id);

    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.length).toBeLessThanOrEqual(3);
    for (const id of seeded) {
      expect(catalogue).toContain(id);
      expect(priced(id), `${id} has no standard price`).toBe(true);
    }
  });
});

describe("what the write sends", () => {
  it("seeds the selected adapter's short model list alongside the key", async () => {
    renderBlock();
    fireEvent.change(await screen.findByLabelText("Model provider"), {
      target: { value: "openai" },
    });
    // Pasted with the whitespace a copy out of a provider console picks up
    // (a newline cannot be used here: a single-line input strips it before the
    // component ever sees it). What gets verified has to be what gets stored.
    await fillKey("  sk-openai  ");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    await waitFor(() => expect(mocks.createModelProvider).toHaveBeenCalledTimes(1));
    expect(mocks.testModelProvider).toHaveBeenCalledWith("ws-1", {
      adapter: "openai",
      apiKey: "sk-openai",
    });
    // A row with a key and no models is accepted, looks saved and offers
    // nothing: the model pickers build a BYOK provider's list from
    // customModels alone.
    expect(mocks.createModelProvider).toHaveBeenCalledWith("ws-1", {
      adapter: "openai",
      provider: ADAPTER_CONFIG.openai.label,
      apiKey: "sk-openai",
      customModels: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"],
    });
  });
});

describe("a write the api refused", () => {
  it("shows the reason the route gave rather than a prompt to retry it", async () => {
    // The entitlement refusal and the schema failures all come back as the
    // route's own string. Retrying any of them resends a request that will be
    // refused on exactly the same grounds.
    mocks.createModelProvider.mockRejectedValue(
      new ApiError(403, "BYOK is not available on your current plan"),
    );

    renderBlock();
    const field = await fillKey("sk-valid-but-unentitled");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    expect(await screen.findByText(/not available on your current plan/)).toBeTruthy();
    expect(screen.queryByText(/Please try again/)).toBeNull();
    // Nothing was stored, so the key stays where it can be reused.
    expect(field.value).toBe("sk-valid-but-unentitled");
  });

  it("keeps the generic line for a response that carried no message of its own", async () => {
    // ApiError synthesizes `API error: <status>` when the body had no `error`
    // field. Putting that on screen tells the user less than saying nothing.
    mocks.createModelProvider.mockRejectedValue(new ApiError(500, { unexpected: true }));

    renderBlock();
    await fillKey("sk-fine");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    expect(await screen.findByText("Could not save the key. Please try again.")).toBeTruthy();
    expect(screen.queryByText(/API error: 500/)).toBeNull();
  });
});

describe("switching provider", () => {
  it("drops the key and the rejection that belonged to the previous one", async () => {
    mocks.testModelProvider.mockResolvedValue({
      success: false,
      error: "Invalid API key",
      detail: "HTTP 401: Unauthorized",
    });

    renderBlock();
    const field = await fillKey("sk-an-openai-key-pasted-under-the-default");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    expect(await screen.findByText(/Invalid API key/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Model provider"), { target: { value: "openai" } });

    // Both belonged to the provider that was selected when they happened.
    expect(screen.queryByText(/Invalid API key/)).toBeNull();
    expect(field.value).toBe("");
    expect(field.placeholder).toBe(`${ADAPTER_CONFIG.openai.label} API key`);
    // And with nothing in the field there is no submit to misdirect.
    expect(
      (screen.getByRole("button", { name: "Verify and save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("a stored row being usable straight away", () => {
  it("refreshes the lists the model pickers read, without a reload", async () => {
    // The assistant panel, the project home page and the detector agent-model
    // link all read ["llm-models", workspaceId]; a row that does not reach it
    // is a key the user has to revisit settings to see.
    const { queryClient } = renderBlock();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await fillKey("sk-fresh");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    await waitFor(() => expect(mocks.createModelProvider).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["llm-models", "ws-1"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["model-providers", "ws-1"] });
  });
});

describe("a workspace the feature is not entitled on", () => {
  it("says so rather than offering a form the write would refuse", async () => {
    mocks.getModelProviders.mockResolvedValue({ byokEnabled: false, providers: [] });

    renderBlock();
    expect(await screen.findByText(/not available on this workspace/)).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(mocks.testModelProvider).not.toHaveBeenCalled();
  });
});

describe("a provider list that cannot be read", () => {
  it("offers no form when the read fails, because the write upserts blindly", async () => {
    // The only guard against replacing a hand-configured row is this list, and
    // the POST auto-fills the label from the adapter. A failed or 403'd read
    // that fell through to the form would let a save overwrite that row's key,
    // base URL, models and enabled flag.
    mocks.getModelProviders.mockRejectedValue(new Error("network down"));

    renderBlock();
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and save" })).toBeNull();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("offers no form when there is no workspace to read the list for", async () => {
    // A query that never runs is not a loading state in react-query v5: with
    // `enabled` false it is pending-but-idle, so `isLoading` is false and the
    // data is simply absent. Absent has to mean "unknown", not "none".
    renderBlock("");
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(mocks.getModelProviders).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });
});

describe("a cached list this mount has not re-read", () => {
  it("offers no form until the refetch behind a cached snapshot has answered", async () => {
    // `staleTime: 0` guarantees the refetch is started, not that it has
    // answered: react-query serves a cached entry at status "success" while it
    // runs, so `isLoading` is false and a guard on it alone draws the form over
    // the old snapshot. The Settings tab reads this very key, so a user who was
    // just there arrives holding one — and if a provider was added in between,
    // the upsert replaces it.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(["model-providers", "ws-1"], { byokEnabled: true, providers: [] });

    let answer: (value: unknown) => void = () => {};
    mocks.getModelProviders.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ModelProviderBlock workspaceId="ws-1" />
      </QueryClientProvider>,
    );

    // In flight, behind a snapshot that says this workspace has no provider.
    await waitFor(() => expect(mocks.getModelProviders).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Loading model providers/)).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and save" })).toBeNull();

    // And it comes back carrying the row that was added after that snapshot.
    await act(async () => {
      answer({
        byokEnabled: true,
        providers: [
          {
            id: "mp-added-since",
            adapter: "anthropic",
            provider: "Anthropic",
            keyPreview: "sk-ant-...new",
            customModels: ["claude-opus-5"],
            enabled: true,
          },
        ],
      });
    });

    expect(await screen.findByText("sk-ant-...new")).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("keeps the form through a later refetch, once this mount has its answer", async () => {
    // The guard asks whether this mount has read the list, not whether a read
    // is in flight. Those differ on every background refetch react-query starts
    // on its own — a window regaining focus while the key is being pasted — and
    // taking the form away there would drop the field mid-paste for a snapshot
    // the step has already seen.
    const { queryClient } = renderBlock();
    const field = await fillKey("sk-half-pasted");

    let answer: (value: unknown) => void = () => {};
    mocks.getModelProviders.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["model-providers", "ws-1"] });
    });

    await waitFor(() => expect(mocks.getModelProviders).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Loading model providers/)).toBeNull();
    expect(field.value).toBe("sk-half-pasted");

    await act(async () => {
      answer({ byokEnabled: true, providers: [] });
    });
    expect(screen.getByLabelText("API key")).toBeTruthy();
  });
});

describe("a provider the workspace already has", () => {
  it("reports the existing row instead of a form that would upsert over it", async () => {
    mocks.getModelProviders.mockResolvedValue({
      byokEnabled: true,
      providers: [
        {
          id: "mp-existing",
          adapter: "anthropic",
          provider: "Anthropic",
          keyPreview: "sk-ant-...xyz",
          customModels: ["claude-opus-5"],
          enabled: true,
        },
      ],
    });

    renderBlock();
    expect(await screen.findByText("sk-ant-...xyz")).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and save" })).toBeNull();
    expect(screen.getByText(/already uses its own key/)).toBeTruthy();
    expect(screen.queryByText("Turned off")).toBeNull();
  });

  it("says a row that is switched off is switched off, and still offers no form", async () => {
    // A disabled row means the workspace is running on system models, so the
    // enabled-row copy would be false. It is still a row the step must not
    // write through: the upsert keys on (workspace, label), so a save would
    // replace its key and switch it back on at the same time.
    mocks.getModelProviders.mockResolvedValue({
      byokEnabled: true,
      providers: [
        {
          id: "mp-off",
          adapter: "anthropic",
          provider: "Anthropic",
          keyPreview: "sk-ant-...off",
          customModels: ["claude-opus-5"],
          enabled: false,
        },
      ],
    });

    renderBlock();
    expect(await screen.findByText("Turned off")).toBeTruthy();
    expect(
      screen.getByText(/turned off, so the AI assistant and detectors still run/),
    ).toBeTruthy();
    expect(screen.queryByText(/already uses its own key/)).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and save" })).toBeNull();
  });
});

describe("a member who cannot write one", () => {
  it("says nothing about admins until the role is known", async () => {
    // The role decides which state is honest, so showing one early tells an
    // admin to go and find an admin. Asserted as a steady state: the provider
    // list is let settle first, so the only thing still outstanding is the
    // role, and the step must still be holding.
    mocks.workspace.data = undefined;
    mocks.workspace.isLoading = true;

    renderBlock();
    await waitFor(() => expect(mocks.getModelProviders).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(screen.getByText("Loading model providers...")).toBeTruthy();
    expect(screen.queryByText(/A workspace admin can add one/)).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("shows the state rather than a form that would be refused", async () => {
    mocks.workspace.data = { role: "MEMBER" };

    renderBlock();
    expect(await screen.findByText(/A workspace admin can add one/)).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(mocks.testModelProvider).not.toHaveBeenCalled();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("claims nothing about the reader when the role cannot be read at all", async () => {
    // An errored read is not a loading state: react-query drops `isLoading`
    // with no data behind it, so the role gate saw "not an admin" and told
    // whoever was looking — the workspace's own admin, as likely as not — that
    // adding a key was someone else's job. Only the list had this branch.
    mocks.workspace.data = undefined;
    mocks.workspace.isError = true;

    renderBlock();
    expect(await screen.findByText(/settings could not be read/)).toBeTruthy();
    expect(screen.queryByText(/A workspace admin can add one/)).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("keeps the form for an admin whose role outlives a failed refetch", async () => {
    // react-query keeps the data it has when a background refetch errors, so the
    // role is still known — failing closed on the error alone would take the
    // form away from the admin mid-paste for a sentence nobody needed.
    mocks.workspace.data = { role: "ADMIN" };
    mocks.workspace.isError = true;

    renderBlock();
    expect(await screen.findByLabelText("API key")).toBeTruthy();
    expect(screen.queryByText(/settings could not be read/)).toBeNull();
  });
});

describe("no adapter a pasted key fully configures", () => {
  it("names where the providers live instead of throwing through the whole tab", async () => {
    // INLINE_ADAPTERS is derived once at module load, so an empty list can only
    // be reached by reloading the module over an empty catalogue: with no
    // catalogue anywhere there is nothing left to seed, and every adapter
    // fails the second half of the rule. `useState(INLINE_ADAPTERS[0])` then held undefined and
    // `ADAPTER_CONFIG[undefined].label` threw from render — and because this
    // block renders inline in ManualTab, that took the API key, the SDK install
    // and the integration picker with it.
    vi.resetModules();
    vi.doMock("@traceroot/core", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@traceroot/core")>()),
      ADAPTER_MODELS: {},
    }));
    try {
      const fresh = await import("./ModelProviderBlock");
      expect(fresh.INLINE_ADAPTERS).toEqual([]);

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <fresh.ModelProviderBlock workspaceId="ws-1" />
        </QueryClientProvider>,
      );

      expect(await screen.findByText(/workspace settings/)).toBeTruthy();
      expect(screen.queryByLabelText("API key")).toBeNull();
      expect(screen.queryByLabelText("Model provider")).toBeNull();
    } finally {
      vi.doUnmock("@traceroot/core");
      vi.resetModules();
    }
  });
});

describe("the links out to settings", () => {
  // Three states carry a link to the same in-app route. A plain <a href> to it
  // forces a full document load, which tears down the QueryClient and every
  // cached query in the getting-started panel this step renders inside.
  const states: [string, () => void][] = [
    [
      "an unreadable provider list",
      () => mocks.getModelProviders.mockRejectedValue(new Error("network down")),
    ],
    [
      "a provider the workspace already has",
      () =>
        mocks.getModelProviders.mockResolvedValue({
          byokEnabled: true,
          providers: [
            {
              id: "mp-existing",
              adapter: "anthropic",
              provider: "Anthropic",
              keyPreview: "sk-ant-...xyz",
              customModels: ["claude-opus-5"],
              enabled: true,
            },
          ],
        }),
    ],
    [
      "a member who cannot write one",
      () => {
        mocks.workspace.data = { role: "MEMBER" };
      },
    ],
  ];

  for (const [state, arrange] of states) {
    it(`routes the link shown for ${state} through the app`, async () => {
      arrange();
      renderBlock();
      const link = await screen.findByRole("link", { name: /Settings/ });
      expect(link.getAttribute("href")).toBe("/workspaces/ws-1/settings/model-providers");
      expect(link.hasAttribute("data-nextlink")).toBe(true);
    });
  }
});

describe("skipping the step", () => {
  it("writes nothing when the step is left alone", async () => {
    renderBlock();
    const field = (await screen.findByLabelText("API key")) as HTMLInputElement;
    // Rendering and reading the state is all an untouched step may do. The
    // field starts empty because the user is the only source of the key:
    // nothing is read from their machine, environment or files.
    expect(field.value).toBe("");
    expect(mocks.testModelProvider).not.toHaveBeenCalled();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("cannot be submitted with an empty key", async () => {
    renderBlock();
    await screen.findByLabelText("API key");
    expect(
      (screen.getByRole("button", { name: "Verify and save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
