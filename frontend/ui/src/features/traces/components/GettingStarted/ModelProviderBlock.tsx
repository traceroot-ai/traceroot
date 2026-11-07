"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { ADAPTER_CONFIG, ADAPTER_MODELS, LLMAdapter, PROVIDER_PRIORITY } from "@traceroot/core";
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
import type { ProviderKeyBinding } from "./integrations";

/**
 * Whether this step can configure an adapter by itself, from that adapter's two
 * table entries.
 *
 * An adapter qualifies on two counts. A single pasted key has to be the whole
 * credential — `credentialType: "api-key"` with no base URL to ask for — which
 * leaves out Azure OpenAI (needs a base URL) and AWS Bedrock (an access-key
 * pair or a default-credentials toggle, plus a region). And there have to be
 * models to seed — see {@link SEEDED_MODELS} — which leaves out OpenRouter:
 * `listWorkspaceModels` builds a BYOK provider's models purely from the row's
 * `customModels`, so a row saved with a key and nothing to seed is accepted,
 * looks saved, and offers no model anywhere.
 *
 * Takes the entries rather than looking them up so each half of the rule can be
 * checked on its own: in today's tables the two exclude the same three
 * adapters, so a future adapter that needs a base URL *and* has models to seed
 * would otherwise slip in on a condition nothing exercises.
 */
export function isInlineConfigurable(
  config: { credentialType: "api-key" | "aws"; requiresBaseUrl: boolean } | undefined,
  catalogue: readonly unknown[] | undefined,
): boolean {
  return keyIsWholeCredential(config) && (catalogue?.length ?? 0) > 0;
}

/**
 * The credential half of `isInlineConfigurable`, on its own because
 * `settingsOnlyReason` reports which half an adapter failed.
 */
function keyIsWholeCredential(config: Parameters<typeof isInlineConfigurable>[0]): boolean {
  return config?.credentialType === "api-key" && !config.requiresBaseUrl;
}

/**
 * The models a key saved here starts with besides the provider's default: per
 * adapter, the newest priced model in each of the provider's other price tiers,
 * at most two.
 *
 * Not the whole catalogue. `customModels` is what every model picker in the
 * workspace offers for the provider, so seeding `ADAPTER_MODELS` gave the
 * assistant and detector pickers a dozen ids or more, and some of those have no
 * entry in the standard price table, where their usage is priced at $0. A short
 * list is also closer to the settings form, which starts from none and adds
 * models one at a time; more can be added there. The tests hold every seeded
 * id, the default among them, to the catalogue and the price table, so a
 * catalogue refresh that drops or unprices one fails there rather than in a
 * workspace's bill.
 *
 * The list leaves out the provider's default model, which `seedFor` puts first
 * from the catalogue. A saved key's models are seeded in that order, and
 * `pickDefaultModel` takes the first model of the highest-priority provider, so
 * the first one has to be the catalogue's first id: the model the provider
 * defaulted to before keys were seeded. Taking it from the catalogue keeps the
 * two the same when a catalogue refresh moves the default. The tests hold them
 * equal.
 */
export const SEEDED_MODELS: Partial<Record<LLMAdapter, readonly string[]>> = {
  [LLMAdapter.ANTHROPIC]: ["claude-sonnet-5-5", "claude-haiku-5-5"],
  [LLMAdapter.OPENAI]: ["gpt-6-astra", "gpt-6-luna"],
  [LLMAdapter.DEEPSEEK]: ["deepseek-v4-flash"],
  [LLMAdapter.XAI]: ["grok-4.20"],
  [LLMAdapter.MOONSHOT]: ["kimi-k2.6"],
  [LLMAdapter.ZAI]: ["glm-5-turbo"],
  [LLMAdapter.GOOGLE]: ["gemini-3.1-pro-preview", "gemini-3-flash-preview"],
};

/**
 * The models a key saved for the adapter starts with: the catalogue's default,
 * then the seeded models still in the catalogue. A model the catalogue no
 * longer lists is one the pickers cannot resolve, so it is not stored even
 * while the list above still names it. An adapter the list has no entry for
 * seeds nothing, whatever its catalogue holds.
 */
export function seedFor(adapter: LLMAdapter): string[] {
  const seeded = SEEDED_MODELS[adapter];
  const catalogue = (ADAPTER_MODELS[adapter] ?? []).map((model) => model.id);
  if (seeded === undefined || catalogue.length === 0) return [];
  const [first] = catalogue;
  return [first, ...seeded.filter((id) => id !== first && catalogue.includes(id))];
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
  isInlineConfigurable(ADAPTER_CONFIG[adapter], seedFor(adapter)),
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

/**
 * Which clause of `isInlineConfigurable` this adapter fails, or null when it
 * fails neither and the step can configure it inline.
 *
 * Pulled out of the sentence below because the step now reaches it one adapter
 * at a time as well: a stack bound to Azure, Bedrock or OpenRouter has to be
 * told why its own key cannot be pasted here, in the same terms as the list.
 */
export function settingsOnlyReason(adapter: LLMAdapter): "more-than-a-key" | "model-list" | null {
  const config = ADAPTER_CONFIG[adapter];
  if (isInlineConfigurable(config, seedFor(adapter))) return null;
  return keyIsWholeCredential(config) ? "model-list" : "more-than-a-key";
}

/**
 * The line under a stored key: one sentence, and the clause that introduces the
 * settings link.
 *
 * The step is reached in two situations that need opposite sentences. "This
 * workspace already uses its own key", shown the instant a save settles, reads
 * as a refusal — as if the key the user had just pasted were dropped because
 * one was there already. On a later visit to a workspace somebody set up
 * before, that same sentence is the honest one. `justSavedLabel` is what
 * separates them: set when this mount stored the key itself, and carrying the
 * provider it was stored for, so the confirmation names what the user chose.
 *
 * Short, because the rows above say most of it: the provider, the key preview,
 * and a check or "Turned off" against each. What is left for the text is only
 * what the rows cannot show — that the probe passed and where the key's models
 * can now be chosen, that nothing was overwritten, or that a key being off is a
 * key nothing uses.
 *
 * None of these lines offers a second provider. This step configures one key;
 * the settings link is where that key is replaced or switched, not somewhere to
 * go and collect a set.
 */
export function storedKeyCopy({
  usingOwnKey,
  justSavedLabel,
  count,
}: {
  usingOwnKey: boolean;
  /**
   * The provider label this mount stored a key for, when it stored one. A
   * save with no label still counts as a save, so this is `undefined` for a
   * key that was already there and `null` for one stored under a provider
   * whose label could not be read back.
   */
  justSavedLabel?: string | null;
  count: number;
}): { state: string; settings: string } {
  // Every row off means nothing can use these keys: the model pickers list
  // enabled providers only, and every key lookup skips a disabled row. That
  // holds on the mount that did the storing too, in the case where the stored
  // row came back disabled. What matters then is that the key is present and
  // inert, which this says either way, so this branch needs no notion of who
  // stored it. It does not say what runs instead: a detector set to one of
  // these models fails rather than moving to TraceRoot's.
  if (!usingOwnKey) {
    return {
      state:
        count > 1
          ? "All of these are off, so the AI assistant and detectors can't use any of them."
          : "This key is off, so the AI assistant and detectors can't use it.",
      settings: count > 1 ? "Turn one back on in" : "Turn it back on in",
    };
  }

  const settings = count > 1 ? "Manage them in" : "Replace or remove it in";

  // Confirm the paste, in the terms the form promised it in, rather than
  // describing a workspace state the user has not arrived at from anywhere.
  //
  // A save makes the key's models available; it does not move anything onto
  // them. A detector keeps the model it was saved with, and the "system"
  // source it starts on takes the server's own key first. The assistant's
  // default is picked by provider priority across workspace and TraceRoot
  // models together, so where the deployment has an Anthropic key of its own,
  // an OpenAI key leaves it on a TraceRoot Anthropic model.
  // So the line says where the models now appear, and that choosing one is the
  // step left.
  if (justSavedLabel !== undefined) {
    return {
      state: justSavedLabel
        ? `Verified and saved. Its models are now offered in the AI assistant's model menu and as a detector's model; choose one there to run on your own ${justSavedLabel} account.`
        : "Verified and saved. Its models are now offered in the AI assistant's model menu and as a detector's model; choose one there to run on your own account.",
      settings,
    };
  }

  // A key that was there before this step read the list. Past tense, and
  // explicit that nothing was written, because nothing was: the form is not
  // offered at all once the list comes back non-empty.
  return {
    state:
      count > 1
        ? "These were already here, and nothing was changed."
        : "This was already here, and nothing was changed.",
    settings,
  };
}

/**
 * For a failure that carries nothing the user can act on. Every response that
 * does carry something shows that instead.
 */
const GENERIC_SAVE_FAILURE = "Could not save the key. Please try again.";

/**
 * What a selection whose provider cannot be configured from here is told.
 *
 * The only words in this section that are not a label, and they are here
 * because the alternative is a heading with nothing under it: the reader picked
 * a stack, the key field vanished, and nothing says whether that is a bug.
 *
 * Two different situations, kept apart because the honest sentence differs.
 * `settingsOnlyReason` covers a provider TraceRoot does have an adapter for
 * that this step cannot finish on its own — Azure needs a base URL, Bedrock an
 * access-key pair and a region, OpenRouter a model list. `none` covers a
 * provider there is no adapter for at all, Mistral today: nothing anywhere in
 * TraceRoot can store that key, so pointing at settings as if it could would
 * send the user looking for a row that is not there.
 *
 * Neither line names the selected stack. It is on screen a few lines above,
 * checked, and for every entry that reaches here it is also the provider's own
 * name — so saying it produced "Mistral calls Mistral, and TraceRoot has no
 * Mistral adapter".
 */
export function unavailableKeyCopy(binding: ProviderKeyBinding): {
  state: string;
  settings: string | null;
} {
  if (binding.kind === "none") {
    return {
      state: `TraceRoot has no ${binding.provider} adapter, so there is no key to paste here.`,
      settings: null,
    };
  }

  const label = ADAPTER_CONFIG[binding.adapter].label;
  return {
    state:
      settingsOnlyReason(binding.adapter) === "more-than-a-key"
        ? `${label} needs more than a key.`
        : `${label} needs a model list chosen.`,
    settings: "Add it in",
  };
}

interface ModelProviderBlockProps {
  workspaceId: string;
  /**
   * Which provider key the selected stack asks for. The step no longer asks
   * the user this separately: a LangChain reader is shown an OpenAI field
   * because LangChain's own example calls OpenAI, and a Mistral reader is told
   * there is no Mistral adapter rather than handed a field for one.
   */
  providerKey: ProviderKeyBinding;
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
 *
 * What it does not do is ask which provider. The panel above it already asked
 * which stack, and that answer contains this one — LangChain's own example
 * calls OpenAI, Claude Agent SDK can only call Anthropic — so asking again
 * invites a mismatch between the snippet the reader is about to paste and the
 * key they are about to store. The binding arrives as `providerKey`; the
 * dropdown survives only for the stacks where the question is real.
 */
export function ModelProviderBlock({ workspaceId, providerKey }: ModelProviderBlockProps) {
  const queryClient = useQueryClient();
  // Set only when the user overrides a *suggested* provider. The selection is
  // the source of truth otherwise, so there is no second piece of state for the
  // two of them to disagree in.
  const [override, setOverride] = useState<LLMAdapter | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null);

  // Everything above belongs to the stack that was selected when it happened:
  // the override, the half-typed key, the provider's rejection. React's recipe
  // for adjusting state when a prop changes drops all three during the render
  // that first sees a new binding, so none of them can survive under another
  // provider's label with "Verify and save" ready to send the old key to the
  // new provider. The bindings are literals in the catalogue, so identity is
  // stable per entry and re-selecting the same stack changes nothing.
  //
  // A save already in flight when that happens is the one case the reset cannot
  // reach: it settles later, and its callbacks would write to fields that now
  // belong to another provider -- a success clearing a key just typed for the
  // new one, a rejection appearing under the new one's label. So the binding is
  // mirrored into a ref here, the mutation tags itself with the value it started
  // under, and the callbacks compare the two. A ref rather than this closure
  // because the callbacks outlive the render that queued them.
  const liveBinding = useRef(providerKey);
  const [bindingSeen, setBindingSeen] = useState(providerKey);
  if (bindingSeen !== providerKey) {
    setBindingSeen(providerKey);
    liveBinding.current = providerKey;
    setOverride(null);
    setApiKey("");
    setFailure(null);
  }

  // Both undefined for a stack whose provider has no adapter at all, which the
  // render path below has to survive rather than throw on. Splitting the
  // binding out first is what lets the form below read `bound.kind` as the two
  // cases that reach it, instead of re-checking the third.
  const bound = providerKey.kind === "none" ? undefined : providerKey;
  const adapter = override ?? bound?.adapter;

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
      // Seed a few models alongside the key: the model pickers build a BYOK
      // provider's models from `customModels` alone, so a key on its own would
      // store a provider that offers nothing. See {@link SEEDED_MODELS}.
      return createModelProvider(workspaceId, {
        adapter: chosen,
        provider: ADAPTER_CONFIG[chosen].label,
        apiKey: credential,
        customModels: seedFor(chosen),
      });
    },
    // The binding this save belongs to travels with it, so the callbacks below
    // can tell their own stack from the one on screen now.
    onMutate: () => {
      setFailure(null);
      return { binding: liveBinding.current };
    },
    onSuccess: (_stored, _chosen, context) => {
      // The keys the assistant panel, the project home page and the detector
      // agent-model link read, so the stored provider shows up without a reload.
      // Invalidated whichever stack is on screen: the row was written either
      // way, and the surfaces that read it are not this step's.
      queryClient.invalidateQueries({ queryKey: ["model-providers", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["llm-models", workspaceId] });
      // The field, though, is the new stack's. Clearing it here would throw away
      // a key typed for a provider this save never touched.
      if (context?.binding !== liveBinding.current) return;
      setApiKey("");
    },
    // The key stays in the field on every failure: nothing was stored, and it is
    // the one thing on screen the user cannot retype from memory. A rejection
    // that arrives after the stack changed is dropped instead: it is the old
    // provider's answer about the old key, and the fields it would explain are
    // gone.
    onError: (error, _chosen, context) => {
      if (context?.binding !== liveBinding.current) return;
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
  // It is also why this step configures one key and then stops offering the
  // form. The paragraph below says where that key is managed and deliberately
  // neither offers nor promises a second: the row is the workspace's one model
  // provider as far as getting started is concerned. `model_providers` still
  // holds a row per provider for the surfaces that do manage a set, and
  // nothing here narrows that.
  //
  // What `enabled` decides is which of the stored-key states this is: a
  // workspace whose rows are all off has no key anything can use, so the
  // sentences that offer its models would be false, and a green check against
  // the row would say nothing about why nothing changed.
  if (providers.length > 0) {
    const usingOwnKey = providers.some((provider) => provider.enabled);
    // Whether the key on screen is one this mount just stored, and what it was
    // stored for. The form renders only while the list is empty, so a settled
    // save on this component is unambiguously "the user pasted this here, a
    // moment ago" — no extra state to keep and nothing to thread in from the
    // step around it. It stays set for the life of the mount, which is right: a
    // later background refetch must not turn the paste the user has just made
    // into a configuration that was always there.
    //
    // The provider comes from the mutation's own variable rather than the
    // row that came back, so the confirmation names the provider the user
    // picked even if the list is slower or holds more than this one row.
    const justSavedLabel = saveMutation.isSuccess
      ? (ADAPTER_CONFIG[saveMutation.variables]?.label ?? null)
      : undefined;
    const copy = storedKeyCopy({ usingOwnKey, justSavedLabel, count: providers.length });
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
          {copy.state} {copy.settings}{" "}
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

  // Fail closed when the role is not there to read, for the same reason as the
  // list above: an errored read leaves `workspace` undefined with `isLoading`
  // already false, and `canManage` then says "not an admin" about a user it
  // knows nothing about — which is how the branch below comes to tell this
  // workspace's own admin to go and find an admin. Claim nothing about the
  // reader; the link works either way.
  //
  // Keyed on the data rather than on `isError`, unlike the list: a background
  // refetch that fails keeps the role already read, and the role only picks
  // which sentence is honest — the write is refused to a non-admin server-side
  // either way — so withdrawing the form mid-paste over it would buy nothing.
  if (!workspace) {
    return (
      <p className="text-[12px] text-muted-foreground">
        This workspace&apos;s settings could not be read, so this step cannot tell whether you can
        add a key here. Check or add one in{" "}
        <Link href={settingsHref} className="font-medium underline underline-offset-4">
          Settings &rarr; Model Providers
        </Link>
        .
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

  // A stack whose provider this step cannot store a key for: no adapter at
  // all, or one the inline rule excludes. Drawing the field anyway would be a
  // field that cannot work — and `ADAPTER_CONFIG[adapter]` on the first of
  // those is a lookup on undefined, which would throw from render and take the
  // API key, the SDK install and the stack picker down with it, since this
  // block renders inline in the same panel.
  if (!bound || !adapter || settingsOnlyReason(adapter) !== null) {
    const copy = unavailableKeyCopy(adapter ? { kind: "fixed", adapter } : providerKey);
    return (
      <p className="text-[12px] text-muted-foreground">
        {copy.state}
        {copy.settings ? (
          <>
            {" "}
            {copy.settings}{" "}
            <Link href={settingsHref} className="font-medium underline underline-offset-4">
              Settings &rarr; Model Providers
            </Link>
            .
          </>
        ) : null}
      </p>
    );
  }

  const label = ADAPTER_CONFIG[adapter].label;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {/* Offered only where it is a real question. A provider's own SDK can
            only use that provider's key, so a dropdown over it would be a
            choice with one right answer and several wrong ones; a framework
            that calls whatever it is handed genuinely has to be switchable,
            and the catalogue's own example is only a starting point. */}
        {bound.kind === "suggested" && (
          <Select
            value={adapter}
            // Held while a save runs. The guard on the save's callbacks compares
            // the stack, and switching provider here keeps the stack, so a
            // rejection that settled after a switch landed under the new
            // provider's field, naming a key it was never sent.
            disabled={saveMutation.isPending}
            onValueChange={(value) => {
              setOverride(value as LLMAdapter);
              // A key belongs to the provider that issued it, and so does the
              // rejection the probe came back with. Carrying either across the
              // switch leaves one provider's error on screen under another
              // provider's form, with "Verify and save" ready to send the old
              // key to the new provider.
              setApiKey("");
              setFailure(null);
            }}
          >
            <SelectTrigger
              aria-label="Model provider"
              className="h-8 w-[180px] shrink-0 text-[12px]"
            >
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
        )}

        <Input
          type="password"
          aria-label={`${label} API key`}
          autoComplete="off"
          placeholder={`${label} API key`}
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
    </div>
  );
}
