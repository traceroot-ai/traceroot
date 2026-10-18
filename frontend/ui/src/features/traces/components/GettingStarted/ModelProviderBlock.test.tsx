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
import {
  INLINE_ADAPTERS,
  isInlineConfigurable,
  keyFieldIntro,
  ModelProviderBlock,
  SETTINGS_ONLY_ADAPTERS,
  settingsOnlyReason,
  storedKeyCopy,
  unavailableKeyCopy,
} from "./ModelProviderBlock";
import type { ProviderKeyBinding } from "./integrations";

/**
 * A provider-agnostic stack: the picker suggests a provider and the user may
 * switch it. Most of what follows is about the form itself rather than the
 * binding, and this is the binding that renders the whole of it.
 */
const SUGGESTED: ProviderKeyBinding = { kind: "suggested", adapter: INLINE_ADAPTERS[0] };

function renderBlock(
  workspaceId = "ws-1",
  providerKey: ProviderKeyBinding = SUGGESTED,
  stackName = "LangChain & LangGraph",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ModelProviderBlock
          workspaceId={workspaceId}
          providerKey={providerKey}
          stackName={stackName}
        />
      </QueryClientProvider>,
    ),
  };
}

const OPENAI: ProviderKeyBinding = { kind: "suggested", adapter: "openai" };
const ANTHROPIC: ProviderKeyBinding = { kind: "fixed", adapter: "anthropic" };

/**
 * A block whose binding can change under it, for the tests about a stack
 * switched mid-step. One query client across both renders, so a save started
 * under the first binding is still the same mutation after the second.
 */
function renderSwitchable(binding: ProviderKeyBinding = OPENAI, stackName = "LangChain") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (next: ProviderKeyBinding, nextStackName: string) => (
    <QueryClientProvider client={queryClient}>
      <ModelProviderBlock workspaceId="ws-1" providerKey={next} stackName={nextStackName} />
    </QueryClientProvider>
  );
  return { queryClient, tree, ...render(tree(binding, stackName)) };
}

// The field is named for the provider the stack asks for, so every lookup for
// it is by suffix rather than by the bare words it used to carry.
async function fillKey(value = "sk-test-key") {
  const field = await screen.findByLabelText(/API key$/);
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

  it("offers every inline adapter as a switch, under a stack that names none", async () => {
    renderBlock("ws-1", { kind: "suggested", adapter: "anthropic" });
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

describe("what the write sends", () => {
  it("seeds the selected adapter's curated model list alongside the key", async () => {
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
      customModels: ADAPTER_MODELS.openai!.map((m) => m.id),
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
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
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
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
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
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
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
        <ModelProviderBlock
          workspaceId="ws-1"
          providerKey={SUGGESTED}
          stackName="LangChain & LangGraph"
        />
      </QueryClientProvider>,
    );

    // In flight, behind a snapshot that says this workspace has no provider.
    await waitFor(() => expect(mocks.getModelProviders).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Loading model providers/)).toBeTruthy();
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
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
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
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
    expect(screen.getByLabelText(/API key$/)).toBeTruthy();
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
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and save" })).toBeNull();
    expect(
      screen.getByText(/already had a key of its own, so this step left it as it was/),
    ).toBeTruthy();
    // Not the just-stored confirmation: nothing was written on this mount.
    expect(screen.queryByText(/key verified and saved/i)).toBeNull();
    expect(screen.getByText(/Replace or remove it in/)).toBeTruthy();
    expect(screen.queryByText("Turned off")).toBeNull();
  });

  it("confirms a key this mount stored rather than calling it pre-existing", async () => {
    // The sequence a first run goes through, and the one this fix came from:
    // the list is empty when the form is offered and holds the new row by the
    // time the read the save invalidated comes back. "This workspace already
    // uses its own key" landed exactly there, over a key the user had just
    // pasted, and read as though the paste had been thrown away.
    const adapter = INLINE_ADAPTERS[0];
    const label = ADAPTER_CONFIG[adapter].label;
    mocks.getModelProviders.mockResolvedValueOnce({ byokEnabled: true, providers: [] });
    mocks.getModelProviders.mockResolvedValue({
      byokEnabled: true,
      providers: [
        {
          id: "mp-new",
          adapter,
          provider: label,
          keyPreview: "sk-...new",
          customModels: (ADAPTER_MODELS[adapter] ?? []).map((model) => model.id),
          enabled: true,
        },
      ],
    });

    renderBlock();
    await fillKey("sk-just-pasted");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    // Named for the provider the user picked, not for the workspace.
    expect(await screen.findByText(new RegExp(`^${label} key verified and saved\\.`))).toBeTruthy();
    expect(screen.queryByText(/already had a key of its own/)).toBeNull();
    // And no invitation to add a second one: this step configures one key.
    expect(screen.queryByText(/add another|add a key for another/i)).toBeNull();
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
    expect(screen.queryByText(/already had a key of its own/)).toBeNull();
    expect(screen.queryByText(/key verified and saved/i)).toBeNull();
    expect(screen.getByText(/Turn it back on in/)).toBeTruthy();
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and save" })).toBeNull();
  });
});

describe("the line a stored key is reported with", () => {
  // The step is reached in two genuinely different situations, and one sentence
  // cannot be honest in both.
  it("confirms the save, under the provider's name, when this mount stored the key", () => {
    expect(storedKeyCopy({ usingOwnKey: true, justSavedLabel: "Anthropic", count: 1 })).toEqual({
      state:
        "Anthropic key verified and saved. The AI assistant, detector screening and root cause analysis now run on your own Anthropic account.",
      settings: "Replace or remove it in",
    });
  });

  it("still confirms the save when the provider it was stored for is unknown", () => {
    const { state } = storedKeyCopy({ usingOwnKey: true, justSavedLabel: null, count: 1 });
    expect(state).toBe(
      "Key verified and saved. The AI assistant, detector screening and root cause analysis now run on your own provider account.",
    );
    expect(state).not.toMatch(/already/);
  });

  it("says a key that was there at mount was left as it was, in the past tense", () => {
    expect(storedKeyCopy({ usingOwnKey: true, count: 1 })).toEqual({
      state: "This workspace already had a key of its own, so this step left it as it was.",
      settings: "Replace or remove it in",
    });
  });

  it("reports a key that is turned off as turned off, stored here or not", () => {
    // A row that came back disabled is still inert, so the save confirmation
    // would be false over it even on the mount that wrote it.
    for (const justSavedLabel of ["Anthropic", null, undefined]) {
      expect(storedKeyCopy({ usingOwnKey: false, justSavedLabel, count: 1 })).toEqual({
        state:
          "This workspace has a key of its own, but it is turned off, so the AI assistant and detectors still run on TraceRoot's models.",
        settings: "Turn it back on in",
      });
    }
  });

  it("speaks of several keys when the list it read holds several", () => {
    // This step stores one key, but it only reads the list: a workspace set up
    // elsewhere first can reach it with more than one row on screen, and the
    // singular would then be describing a table that visibly disagrees.
    expect(storedKeyCopy({ usingOwnKey: true, count: 3 })).toEqual({
      state: "This workspace already had keys of its own, so this step left them as they were.",
      settings: "Manage them in",
    });
    expect(storedKeyCopy({ usingOwnKey: false, count: 3 })).toEqual({
      state:
        "This workspace has keys of its own, but they are all turned off, so the AI assistant and detectors still run on TraceRoot's models.",
      settings: "Turn one back on in",
    });
  });

  it("never offers a second provider, in any state", () => {
    // Onboarding configures one key. The settings link is where that key is
    // replaced or switched back on, not somewhere to go and collect a set, and
    // the line must not read as an invitation to add more.
    for (const usingOwnKey of [true, false]) {
      for (const justSavedLabel of ["Anthropic", undefined]) {
        for (const count of [1, 2]) {
          const { state, settings } = storedKeyCopy({ usingOwnKey, justSavedLabel, count });
          expect(`${state} ${settings}`).not.toMatch(/\badd\b|another|each provider/i);
        }
      }
    }
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
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
  });

  it("shows the state rather than a form that would be refused", async () => {
    mocks.workspace.data = { role: "MEMBER" };

    renderBlock();
    expect(await screen.findByText(/A workspace admin can add one/)).toBeTruthy();
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
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
    expect(await screen.findByLabelText(/API key$/)).toBeTruthy();
    expect(screen.queryByText(/settings could not be read/)).toBeNull();
  });
});

describe("no adapter a pasted key fully configures", () => {
  it("says why rather than throwing through the whole panel", async () => {
    // INLINE_ADAPTERS is derived once at module load, so an empty list can only
    // be reached by reloading the module over an empty catalogue: with no
    // curated models anywhere, every adapter fails the second half of the
    // rule. The adapter the binding names then has nowhere to be configured,
    // and the form must not be drawn over it — this block renders inline in the
    // same panel as the API key, the SDK install and the stack picker, so a
    // throw from here would take all three with it.
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
          <fresh.ModelProviderBlock
            workspaceId="ws-1"
            providerKey={{ kind: "suggested", adapter: "anthropic" }}
            stackName="Agno"
          />
        </QueryClientProvider>,
      );

      expect(
        await screen.findByText(/Agno runs on Anthropic, and Anthropic needs a model list chosen/),
      ).toBeTruthy();
      expect(screen.queryByLabelText(/API key$/)).toBeNull();
      expect(screen.queryByLabelText("Model provider")).toBeNull();
      expect(screen.getByRole("link", { name: /Settings/ }).getAttribute("href")).toBe(
        "/workspaces/ws-1/settings/model-providers",
      );
    } finally {
      vi.doUnmock("@traceroot/core");
      vi.resetModules();
    }
  });
});

describe("the key the selected stack asks for", () => {
  it("names the field for a provider SDK's own provider, with nothing to switch", async () => {
    // Claude Agent SDK can only call Anthropic. A dropdown over that is a
    // question with one right answer and six wrong ones.
    renderBlock("ws-1", { kind: "fixed", adapter: "anthropic" }, "Claude Agent SDK");
    expect(await screen.findByLabelText("Anthropic API key")).toBeTruthy();
    expect(screen.queryByLabelText("Model provider")).toBeNull();
    expect(
      screen.getByText(/Claude Agent SDK runs on Anthropic, so this step takes your Anthropic key/),
    ).toBeTruthy();
  });

  it("names the field for the provider a framework's own example calls", async () => {
    // The mapping the panel is built on: a LangChain reader is shown an OpenAI
    // field because LangChain's own example builds ChatOpenAI — not because
    // OpenAI is the default for everything.
    renderBlock("ws-1", { kind: "suggested", adapter: "openai" }, "LangChain & LangGraph");
    expect(await screen.findByLabelText("OpenAI API key")).toBeTruthy();
    expect(screen.getByText(/its example uses OpenAI/)).toBeTruthy();
    // And here the switch is real, because the framework will take any of them.
    expect(screen.getByLabelText("Model provider")).toBeTruthy();
  });

  it("relabels the field when the user switches a suggested provider", async () => {
    renderBlock("ws-1", { kind: "suggested", adapter: "openai" }, "LangChain & LangGraph");
    await screen.findByLabelText("OpenAI API key");
    fireEvent.change(screen.getByLabelText("Model provider"), { target: { value: "google" } });
    expect(screen.getByLabelText("Google Gemini API key")).toBeTruthy();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
  });

  it("sends the provider the stack named, not the top-ranked one", async () => {
    // The old default was PROVIDER_PRIORITY[0] — Anthropic — for every stack.
    renderBlock("ws-1", { kind: "fixed", adapter: "google" }, "Google ADK");
    await fillKey("sk-google");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    await waitFor(() => expect(mocks.createModelProvider).toHaveBeenCalledTimes(1));
    expect(mocks.testModelProvider).toHaveBeenCalledWith("ws-1", {
      adapter: "google",
      apiKey: "sk-google",
    });
    expect(mocks.createModelProvider).toHaveBeenCalledWith("ws-1", {
      adapter: "google",
      provider: ADAPTER_CONFIG.google.label,
      apiKey: "sk-google",
      customModels: ADAPTER_MODELS.google!.map((m) => m.id),
    });
  });

  it("drops a half-typed key and its rejection when the stack changes under it", async () => {
    // Switching stack is switching provider, so the same rule applies as
    // switching it by hand: the key and the error belonged to the old one.
    mocks.testModelProvider.mockResolvedValue({ success: false, error: "Invalid API key" });

    const { rerender, tree } = renderSwitchable();

    const field = await fillKey("sk-an-openai-key");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    expect(await screen.findByText(/Invalid API key/)).toBeTruthy();

    rerender(tree(ANTHROPIC, "Claude Agent SDK"));

    expect(screen.queryByText(/Invalid API key/)).toBeNull();
    expect(screen.getByLabelText("Anthropic API key")).toBeTruthy();
    expect(field.value).toBe("");
    // A provider chosen by hand is dropped with it: the new stack names its own.
    expect(screen.queryByLabelText("Model provider")).toBeNull();
  });

  it("drops a rejection that arrives after the stack changed under the save", async () => {
    // The one state the render-time reset cannot reach: a probe already in
    // flight. Its answer is about the old key and the old provider, so it must
    // not surface under the new provider's label.
    let settleProbe!: (result: { success: boolean; error?: string }) => void;
    mocks.testModelProvider.mockReturnValue(
      new Promise<{ success: boolean; error?: string }>((resolve) => {
        settleProbe = resolve;
      }),
    );

    const { rerender, tree } = renderSwitchable();
    await fillKey("sk-an-openai-key");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    await waitFor(() => expect(mocks.testModelProvider).toHaveBeenCalledTimes(1));

    rerender(tree(ANTHROPIC, "Claude Agent SDK"));
    const field = (await screen.findByLabelText("Anthropic API key")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-an-anthropic-key" } });

    await act(async () => {
      settleProbe({ success: false, error: "Invalid API key" });
    });

    expect(screen.queryByText(/Invalid API key/)).toBeNull();
    expect(field.value).toBe("sk-an-anthropic-key");
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("keeps the key typed for the new stack when the old save succeeds late", async () => {
    let settleProbe!: (result: { success: boolean }) => void;
    mocks.testModelProvider.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        settleProbe = resolve;
      }),
    );

    const { rerender, tree } = renderSwitchable();
    await fillKey("sk-an-openai-key");
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    await waitFor(() => expect(mocks.testModelProvider).toHaveBeenCalledTimes(1));

    rerender(tree(ANTHROPIC, "Claude Agent SDK"));
    const field = (await screen.findByLabelText("Anthropic API key")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-an-anthropic-key" } });

    await act(async () => {
      settleProbe({ success: true });
    });

    // The save completes for the provider it started under -- that key was
    // verified and is worth storing -- but the field now holds another
    // provider's key, and clearing it would throw that away.
    await waitFor(() => expect(mocks.createModelProvider).toHaveBeenCalledTimes(1));
    expect(mocks.createModelProvider.mock.calls[0][1].adapter).toBe("openai");
    expect(field.value).toBe("sk-an-anthropic-key");
  });

  it("says there is no adapter at all rather than offering a field for one", async () => {
    // Mistral's integration is MISTRAL_API_KEY throughout and LLMAdapter has no
    // Mistral entry. Nothing in TraceRoot can store that key, so there is no
    // settings tab to send the reader to for it either.
    renderBlock("ws-1", { kind: "none", provider: "Mistral" }, "Mistral");
    expect(
      await screen.findByText(/TraceRoot has no Mistral adapter for your own keys/),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
    expect(screen.queryByLabelText("Model provider")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and save" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Settings/ })).toBeNull();
  });

  it("says why an offered adapter still cannot be set up from here", async () => {
    // OpenRouter is one of the three the inline rule excludes, and the reason
    // it gives is the clause it actually failed: its key is the whole
    // credential, it just ships no curated model list.
    renderBlock("ws-1", { kind: "fixed", adapter: "openrouter" }, "OpenRouter");
    expect(
      await screen.findByText(/^OpenRouter needs a model list chosen, so it cannot be set up/),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
    expect(screen.getByRole("link", { name: /Settings/ })).toBeTruthy();
  });

  it("keeps offering only one key when the workspace already has one", async () => {
    // Picking a different stack over a stored key must not reopen the form for
    // a second provider: the write upserts on (workspace, label), and this step
    // configures one key.
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

    renderBlock("ws-1", { kind: "fixed", adapter: "openai" }, "OpenAI");
    expect(await screen.findByText("sk-ant-...xyz")).toBeTruthy();
    expect(screen.queryByLabelText(/API key$/)).toBeNull();
    expect(screen.queryByText(/add another|add a key for another/i)).toBeNull();
  });
});

describe("the lines the bound key is introduced with", () => {
  it("states the provider as a consequence of the stack when it is fixed", () => {
    expect(keyFieldIntro({ stackName: "OpenAI Agents SDK", kind: "fixed", label: "OpenAI" })).toBe(
      "Optional. OpenAI Agents SDK runs on OpenAI, so this step takes your OpenAI key: paste it and the AI assistant, detector screening and root cause analysis run on your own OpenAI account instead of TraceRoot's models.",
    );
  });

  it("offers it as the example's provider, and says it can be switched", () => {
    const line = keyFieldIntro({ stackName: "CrewAI", kind: "suggested", label: "OpenAI" });
    expect(line).toContain("CrewAI calls whichever provider you give it");
    expect(line).toContain("its example uses OpenAI");
    expect(line).toContain("switch provider");
  });

  it("never invites a second key, in either form", () => {
    for (const kind of ["fixed", "suggested"] as const) {
      expect(keyFieldIntro({ stackName: "CrewAI", kind, label: "OpenAI" })).not.toMatch(
        /\badd\b|another|each provider/i,
      );
    }
  });

  it("sends a provider with no adapter nowhere, and an excluded one to settings", () => {
    // A framework that calls a provider there is no adapter for: both names
    // are needed, because they are two different companies.
    expect(unavailableKeyCopy({ kind: "none", provider: "Mistral" }, "Some Framework")).toEqual({
      state:
        "Some Framework calls Mistral, and TraceRoot has no Mistral adapter for your own keys, so there is no Mistral key to paste here. The AI assistant and detectors run on TraceRoot's models.",
      settings: null,
    });
    // A framework fixed to a provider this step cannot finish configuring.
    expect(unavailableKeyCopy({ kind: "fixed", adapter: "azure" }, "Some Framework")).toEqual({
      state:
        "Some Framework runs on Azure OpenAI, and Azure OpenAI needs more than a key, so it cannot be set up from here.",
      settings: "Add it in",
    });
  });

  it("does not say a provider calls itself", () => {
    // Both live cases in the catalogue: the entry IS the provider, so the
    // opening clause would only repeat the name. Mistral is the `none` entry
    // and OpenRouter the settings-only one, and each is what a customer sees
    // the moment they pick it.
    expect(unavailableKeyCopy({ kind: "none", provider: "Mistral" }, "Mistral")).toEqual({
      state:
        "TraceRoot has no Mistral adapter for your own keys, so there is no key to paste here. The AI assistant and detectors run on TraceRoot's models.",
      settings: null,
    });
    expect(unavailableKeyCopy({ kind: "fixed", adapter: "openrouter" }, "OpenRouter")).toEqual({
      state: "OpenRouter needs a model list chosen, so it cannot be set up from here.",
      settings: "Add it in",
    });
    for (const [binding, stack] of [
      [{ kind: "none", provider: "Mistral" } as const, "Mistral"],
      [{ kind: "fixed", adapter: "openrouter" } as const, "OpenRouter"],
    ] as const) {
      // No name twice over, in either form.
      const { state } = unavailableKeyCopy(binding, stack);
      expect(state.split(stack).length - 1, state).toBe(1);
    }
  });

  it("derives each exclusion from the clause the adapter actually fails", () => {
    expect(settingsOnlyReason("azure")).toBe("more-than-a-key");
    expect(settingsOnlyReason("amazon-bedrock")).toBe("more-than-a-key");
    expect(settingsOnlyReason("openrouter")).toBe("model-list");
    for (const adapter of INLINE_ADAPTERS) {
      expect(settingsOnlyReason(adapter), adapter).toBeNull();
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
    const field = (await screen.findByLabelText(/API key$/)) as HTMLInputElement;
    // Rendering and reading the state is all an untouched step may do. The
    // field starts empty because the user is the only source of the key:
    // nothing is read from their machine, environment or files.
    expect(field.value).toBe("");
    expect(mocks.testModelProvider).not.toHaveBeenCalled();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("cannot be submitted with an empty key", async () => {
    renderBlock();
    await screen.findByLabelText(/API key$/);
    expect(
      (screen.getByRole("button", { name: "Verify and save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
