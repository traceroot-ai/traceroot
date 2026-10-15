"use client";

import { useState } from "react";
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
import { ImpersonationError } from "@/lib/api/errors";

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

function settingsOnlyNote(): string {
  const labels = SETTINGS_ONLY_ADAPTERS.map((adapter) => ADAPTER_CONFIG[adapter].label);
  if (labels.length === 0) return "";
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `${list} need more than a key — add those in workspace settings.`;
}

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
  const [adapter, setAdapter] = useState<LLMAdapter>(INLINE_ADAPTERS[0]);
  const [apiKey, setApiKey] = useState("");
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null);

  const { data: workspace, isLoading: workspaceLoading } = useWorkspace(workspaceId);
  const canManage = workspace?.role === "ADMIN";

  const { data, isLoading } = useQuery({
    queryKey: ["model-providers", workspaceId],
    queryFn: () => getModelProviders(workspaceId),
    enabled: !!workspaceId,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Probe first, and store only on success. A row whose key cannot
      // authenticate is worse than no row: it looks saved here and fails later
      // in a background worker, far from the paste. The probe is bounded by
      // MODEL_PROVIDER_TEST_TIMEOUT_MS server-side, so a provider host that
      // accepts the socket and never answers cannot hang the step.
      // Trimmed once, so the credential that was verified is the credential
      // that gets stored — a pasted key often arrives with a stray newline.
      const credential = apiKey.trim();
      const probe = await testModelProvider(workspaceId, { adapter, apiKey: credential });
      if (!probe.success) {
        throw new ProbeRejected(probe.error || "Connection failed", probe.detail);
      }
      // Seed the curated catalogue alongside the key: the model pickers build a
      // BYOK provider's models from `customModels` alone, so a key on its own
      // would store a provider that offers nothing.
      return createModelProvider(workspaceId, {
        adapter,
        provider: ADAPTER_CONFIG[adapter].label,
        apiKey: credential,
        customModels: (ADAPTER_MODELS[adapter] ?? []).map((model) => model.id),
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
      } else {
        setFailure({ message: "Could not save the key. Please try again." });
      }
    },
  });

  const settingsHref = `/workspaces/${workspaceId}/settings/model-providers`;

  // The role gates which state is the honest one, so nothing is shown until it
  // is known: rendering early would tell an admin to go and find an admin.
  if (isLoading || workspaceLoading) {
    return <p className="text-[12px] text-muted-foreground">Loading model providers...</p>;
  }

  const providers = data?.providers ?? [];

  // Never upsert over a provider the workspace already has: POST upserts on
  // (workspace, label), so writing the default label blindly would replace the
  // key on a row someone configured by hand. Report the state instead.
  if (providers.length > 0) {
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
              <Check className="ml-auto h-4 w-4 shrink-0 text-green-600" />
            </div>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground">
          This workspace already uses its own key. Manage it in{" "}
          <a href={settingsHref} className="font-medium underline underline-offset-4">
            Settings &rarr; Model Providers
          </a>
          .
        </p>
      </div>
    );
  }

  if (data && !data.byokEnabled) {
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
        <a href={settingsHref} className="font-medium underline underline-offset-4">
          Settings &rarr; Model Providers
        </a>
        .
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">
        Optional. Paste a key and the AI assistant, detector screening and root cause analysis run
        on your own provider account instead of TraceRoot&apos;s models.
      </p>

      <div className="flex gap-2">
        <Select value={adapter} onValueChange={(value) => setAdapter(value as LLMAdapter)}>
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
          onClick={() => saveMutation.mutate()}
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
