"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import {
  ADAPTER_CONFIG,
  ADAPTER_MODELS,
  PROVIDER_PRIORITY,
  type LLMAdapter,
} from "@traceroot/core";
import { ProviderIcon } from "@/components/icons/provider-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWorkspace } from "@/features/workspaces/hooks";
import { createModelProvider, getModelProviders, testModelProvider } from "@/lib/api";
import { ApiError, ImpersonationError } from "@/lib/api/errors";

/**
 * Whether this step can configure an adapter by itself, from that adapter's two
 * table entries.
 *
 * An adapter qualifies on two counts. A single pasted key has to be the whole
 * credential — `credentialType: "api-key"` with no base URL to ask for — which
 * leaves out Azure OpenAI (needs a base URL) and AWS Bedrock (an access-key
 * pair or a default-credentials toggle, plus a region). And there has to be a
 * curated catalogue to record, which leaves out OpenRouter: `listWorkspaceModels`
 * builds a BYOK provider's models purely from the row's `customModels`, so a
 * row saved with a key and nothing to seed is accepted, looks saved, and offers
 * no model anywhere.
 *
 * Takes the entries rather than looking them up so each half of the rule can be
 * checked on its own: in today's tables the two exclude the same three
 * adapters, so a future adapter that needs a base URL *and* ships a catalogue
 * would otherwise slip in on a condition nothing exercises.
 */
export function isInlineConfigurable(
  config: { credentialType: "api-key" | "aws"; requiresBaseUrl: boolean } | undefined,
  catalogue: readonly unknown[] | undefined,
): boolean {
  return (
    config?.credentialType === "api-key" && !config.requiresBaseUrl && (catalogue?.length ?? 0) > 0
  );
}

/**
 * The adapters this step offers inline, in the order the product ranks
 * providers.
 *
 * Derived from `PROVIDER_PRIORITY` rather than `ADAPTER_CONFIG`'s keys: the
 * latter also carries the internal `typesafe` decision adapter, which no
 * provider surface offers.
 */
export const INLINE_ADAPTERS: LLMAdapter[] = PROVIDER_PRIORITY.filter((adapter) =>
  isInlineConfigurable(ADAPTER_CONFIG[adapter], ADAPTER_MODELS[adapter]),
);

/** The rest of the offered adapters, for the line that says where they live. */
export const SETTINGS_ONLY_ADAPTERS: LLMAdapter[] = PROVIDER_PRIORITY.filter(
  (adapter) => !INLINE_ADAPTERS.includes(adapter),
);

/**
 * The provider answered the probe and rejected the credential, as opposed to
 * the request to our own API failing. The provider's own words are worth
 * showing; a transport failure's are not.
 */
class ProbeRejected extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "ProbeRejected";
    this.detail = detail;
  }
}

/** "a", "a and b", "a, b and c". */
function joinLabels(labels: string[]): string {
  return labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Why each adapter this step does not offer lives in settings instead, derived
 * from the clause of `isInlineConfigurable` that adapter failed.
 *
 * The two clauses are not the same reason and cannot be reported as one. Azure
 * OpenAI needs a base URL and AWS Bedrock needs an access-key pair or a
 * default-credentials toggle plus a region, so for those a key genuinely is not
 * the whole credential. OpenRouter's key is its whole credential — it is here
 * only for shipping no curated catalogue, and a row stored with a key and
 * nothing to seed offers no model anywhere. Telling the user it "needs more
 * than a key" is untrue, and would stay untrue for the next catalogue-less
 * single-key adapter the tables gain.
 */
function settingsOnlyNote(): string {
  const needMoreThanAKey: string[] = [];
  const needAModelList: string[] = [];
  for (const adapter of SETTINGS_ONLY_ADAPTERS) {
    const config = ADAPTER_CONFIG[adapter];
    if (config.credentialType !== "api-key" || config.requiresBaseUrl) {
      needMoreThanAKey.push(config.label);
    } else {
      needAModelList.push(config.label);
    }
  }

  const clauses: string[] = [];
  if (needMoreThanAKey.length > 0) {
    const verb = needMoreThanAKey.length === 1 ? "needs" : "need";
    clauses.push(`${joinLabels(needMoreThanAKey)} ${verb} more than a key`);
  }
  if (needAModelList.length > 0) {
    const verb = needAModelList.length === 1 ? "needs" : "need";
    clauses.push(`${joinLabels(needAModelList)} ${verb} a model list chosen`);
  }
  if (clauses.length === 0) return "";
  return `${clauses.join(", and ")} — add those in workspace settings.`;
}

/**
 * For a failure that carries nothing the user can act on. Every response that
 * does carry something shows that instead.
 */
const GENERIC_SAVE_FAILURE = "Could not save the key. Please try again.";

interface ModelProviderBlockProps {
  workspaceId: string;
}

/**
 * Takes a model provider key where the user already is, and stores it as a real
 * `model_providers` row for the workspace.
 *
 * Setting up by hand is otherwise half a path: the surrounding steps instrument
 * an application, and nothing in them says which model the AI assistant,
 * detector screening and detector root-cause analysis will call. The capability
 * is not missing — the whole BYOK system exists — but it is reachable only from
 * a workspace settings tab a new account has no reason to have found. So this
 * block is a form over the endpoints that are already there: no new table, no
 * new route, no second credential store.
 *
 * The step is optional in the structural sense. There is no required field,
 * the manual path completes without touching it, and skipping it writes
 * nothing: a workspace that skips is left exactly as it is today.
 */
export function ModelProviderBlock({ workspaceId }: ModelProviderBlockProps) {
  const queryClient = useQueryClient();
  // Undefined when no adapter qualifies for the inline rule at all, which the
  // render path below has to survive rather than throw on.
  const [adapter, setAdapter] = useState<LLMAdapter | undefined>(INLINE_ADAPTERS[0]);
  const [apiKey, setApiKey] = useState("");
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null);

  const { data: workspace, isLoading: workspaceLoading } = useWorkspace(workspaceId);
  const canManage = workspace?.role === "ADMIN";

  const {
    data,
    fetchStatus,
    isFetchedAfterMount,
    isError: providersUnreadable,
  } = useQuery({
    queryKey: ["model-providers", workspaceId],
    queryFn: () => getModelProviders(workspaceId),
    enabled: !!workspaceId,
    // Read the list fresh every time the step mounts, against the app-wide
    // 60-second staleTime. The guard below is the only thing standing between a
    // blind upsert and a hand-configured row, and a minute-old snapshot that
    // says "none" is indistinguishable here from a current one.
    staleTime: 0,
  });

  const saveMutation = useMutation({
    // The adapter arrives as the mutation's variable rather than being read off
    // state in here. The form is this mutation's only caller and does not
    // render without an adapter, so the narrowing is structural: nothing in
    // here has to account for an unselected provider.
    mutationFn: async (chosen: LLMAdapter) => {
      // Probe first, and store only on success. A row whose key cannot
      // authenticate is worse than no row: it looks saved here and fails later
      // in a background worker, far from the paste. The probe is bounded by
      // MODEL_PROVIDER_TEST_TIMEOUT_MS server-side, so a provider host that
      // accepts the socket and never answers cannot hang the step.
      // Trimmed once, so the credential that was verified is the credential
      // that gets stored — a pasted key often arrives with a stray newline.
      const credential = apiKey.trim();
      const probe = await testModelProvider(workspaceId, { adapter: chosen, apiKey: credential });
      if (!probe.success) {
        throw new ProbeRejected(probe.error || "Connection failed", probe.detail);
      }
      // Seed the curated catalogue alongside the key: the model pickers build a
      // BYOK provider's models from `customModels` alone, so a key on its own
      // would store a provider that offers nothing.
      return createModelProvider(workspaceId, {
        adapter: chosen,
        provider: ADAPTER_CONFIG[chosen].label,
        apiKey: credential,
        customModels: (ADAPTER_MODELS[chosen] ?? []).map((model) => model.id),
      });
    },
    onMutate: () => setFailure(null),
    onSuccess: () => {
      // The keys the assistant panel, the project home page and the detector
      // agent-model link read, so the stored provider shows up without a reload.
      queryClient.invalidateQueries({ queryKey: ["model-providers", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["llm-models", workspaceId] });
      setApiKey("");
    },
    // The key stays in the field on every failure: nothing was stored, and it is
    // the one thing on screen the user cannot retype from memory.
    onError: (error) => {
      if (error instanceof ProbeRejected) {
        setFailure({ message: error.message, detail: error.detail });
      } else if (error instanceof ImpersonationError) {
        setFailure({ message: error.message });
      } else if (error instanceof ApiError) {
        // The route's own words, which are written for this reader: "BYOK is
        // not available on your current plan" on a 403, "API key is required"
        // or the first schema issue on a 400. Collapsing those into a retry
        // prompt invites the user to keep resending a request that cannot
        // succeed however many times they send it.
        //
        // A response that carried no message of its own leaves ApiError holding
        // the status it synthesizes in that case, which tells the user nothing,
        // so that one keeps the generic line.
        const synthesized = error.message === `API error: ${error.status}`;
        setFailure({ message: synthesized ? GENERIC_SAVE_FAILURE : error.message });
      } else {
        setFailure({ message: GENERIC_SAVE_FAILURE });
      }
    },
  });

  const settingsHref = `/workspaces/${workspaceId}/settings/model-providers`;

  // Nothing is drawn until both the role and this mount's own read of the list
  // have answered. The role gates which state is the honest one — rendering
  // early would tell an admin to go and find an admin.
  //
  // The read is held to `isFetchedAfterMount` rather than `isLoading`, because
  // `staleTime: 0` only guarantees the refetch is *started*: react-query serves
  // a cached entry at status "success" while that refetch runs, so `isLoading`
  // is false and a guard on it would draw the form over the stale snapshot. The
  // workspace settings tab reads this same key, so a user arriving from it
  // holds one — and a provider added between that snapshot and now would be
  // upserted over by the save, which is the failure the guard below exists to
  // prevent. The flag flips once per mount and stays set, so a later background
  // refetch (a window regaining focus mid-paste) does not take the form away.
  if (workspaceLoading || (fetchStatus !== "idle" && !isFetchedAfterMount)) {
    return <p className="text-[12px] text-muted-foreground">Loading model providers...</p>;
  }

  // Fail closed when the list is not there to check. An unreadable or
  // never-issued read leaves `data` undefined, which the guard below would
  // otherwise read as "this workspace has none" — and the write is an
  // unconditional upsert on (workspace, label) with the label auto-filled from
  // the adapter, so saving through a transient failure would replace the key,
  // base URL, models and enabled flag on a row someone configured by hand.
  // Having no form at all is the lesser outcome for an optional step.
  //
  // `isFetchedAfterMount` is required here as well, so that a cached entry
  // cannot stand in for a read that never ran at all: with `enabled` false
  // there is no fetch for the guard above to wait on, and a snapshot another
  // screen left behind is not an answer about this workspace now.
  if (providersUnreadable || !data || !isFetchedAfterMount) {
    return (
      <p className="text-[12px] text-muted-foreground">
        This workspace&apos;s model providers could not be read, so this step cannot tell whether it
        already has a key. Check or add one in{" "}
        <Link href={settingsHref} className="font-medium underline underline-offset-4">
          Settings &rarr; Model Providers
        </Link>
        .
      </p>
    );
  }

  const providers = data.providers;

  // Never upsert over a provider the workspace already has, and that counts a
  // row that is switched off. POST upserts on (workspace, label), so writing
  // the default label blindly would replace the key, base URL and models on a
  // row someone configured by hand — and on a disabled row it would quietly
  // switch it back on as well. A row that is off is still a row the step must
  // not write through, so the rule stays blind to `enabled`.
  //
  // What `enabled` does decide is which state this is. A workspace whose only
  // row is off is running on TraceRoot's models, so telling it that it "already
  // uses its own key" would be false, and leaving a green check against the row
  // would say nothing about why nothing changed.
  if (providers.length > 0) {
    const usingOwnKey = providers.some((provider) => provider.enabled);
    return (
      <div className="space-y-1.5">
        <div className="divide-y divide-border rounded-md border border-border">
          {providers.map((provider) => (
            <div key={provider.id} className="flex items-center gap-3 px-4 py-3">
              <ProviderIcon adapter={provider.adapter} className="h-5 w-5 shrink-0" />
              <span className="text-[13px] font-medium text-foreground">{provider.provider}</span>
              <span className="truncate font-mono text-[12px] text-muted-foreground">
                {provider.keyPreview}
              </span>
              {provider.enabled ? (
                <Check className="ml-auto h-4 w-4 shrink-0 text-green-600" />
              ) : (
                <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
                  Turned off
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {usingOwnKey
            ? "This workspace already uses its own key."
            : "This workspace has a key of its own, but it is turned off, so the AI assistant and detectors still run on TraceRoot's models."}{" "}
          Manage it in{" "}
          <Link href={settingsHref} className="font-medium underline underline-offset-4">
            Settings &rarr; Model Providers
          </Link>
          .
        </p>
      </div>
    );
  }

  if (!data.byokEnabled) {
    return (
      <p className="text-[12px] text-muted-foreground">
        Your own model keys are not available on this workspace&apos;s plan. Detectors and the AI
        assistant run on TraceRoot&apos;s models in the meantime.
      </p>
    );
  }

  // Both the write and the probe require workspace ADMIN, so a member who
  // cannot succeed is told the state rather than handed a form that would 403.
  if (!canManage) {
    return (
      <p className="text-[12px] text-muted-foreground">
        This workspace has no model key of its own. A workspace admin can add one in{" "}
        <Link href={settingsHref} className="font-medium underline underline-offset-4">
          Settings &rarr; Model Providers
        </Link>
        .
      </p>
    );
  }

  // No adapter a pasted key fully configures means there is no form to draw,
  // and `ADAPTER_CONFIG[adapter]` would be a lookup on undefined. A TypeError
  // thrown from here does not blank this step: the block renders inline in the
  // Manual tab, so it would take the API key, the SDK install and the
  // integration picker down with it. Say where the providers live instead.
  if (!adapter) {
    return <p className="text-[12px] text-muted-foreground">{settingsOnlyNote()}</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">
        Optional. Paste a key and the AI assistant, detector screening and root cause analysis run
        on your own provider account instead of TraceRoot&apos;s models.
      </p>

      <div className="flex gap-2">
        <Select
          value={adapter}
          onValueChange={(value) => {
            setAdapter(value as LLMAdapter);
            // A key belongs to the provider that issued it, and so does the
            // rejection the probe came back with. Carrying either across the
            // switch leaves one provider's error on screen under another
            // provider's form, with "Verify and save" ready to send the old
            // key to the new provider.
            setApiKey("");
            setFailure(null);
          }}
        >
          <SelectTrigger aria-label="Model provider" className="h-8 w-[180px] shrink-0 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INLINE_ADAPTERS.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {ADAPTER_CONFIG[candidate].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="password"
          aria-label="API key"
          autoComplete="off"
          placeholder={`${ADAPTER_CONFIG[adapter].label} API key`}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className="h-8 flex-1 font-mono text-[12px]"
        />

        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => saveMutation.mutate(adapter)}
          disabled={saveMutation.isPending || apiKey.trim() === ""}
        >
          {saveMutation.isPending ? "Verifying..." : "Verify and save"}
        </Button>
      </div>

      {failure && (
        <p className="text-[12px] text-destructive">
          {failure.message}
          {failure.detail ? ` — ${failure.detail}` : ""}
        </p>
      )}

      <p className="text-[12px] text-muted-foreground">{settingsOnlyNote()}</p>
    </div>
  );
}
