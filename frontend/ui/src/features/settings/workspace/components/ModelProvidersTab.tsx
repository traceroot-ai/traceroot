"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, CheckCircle2, XCircle, ArrowUpRight, X } from "lucide-react";
import { ProviderIcon } from "@/components/icons/provider-icons";
import { Button } from "@/components/ui/button";
import { AddButton } from "@/components/ui/add-button";
import { DeleteIconButton } from "@/components/ui/delete-button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ADAPTER_CONFIG,
  ADAPTER_API_PROTOCOL,
  ADAPTER_AVAILABLE_PROTOCOLS,
  ADAPTER_DEFAULT_BASE_URL,
  ADAPTER_MODELS,
} from "@traceroot/core";
import type { LLMAdapter } from "@traceroot/core";
import {
  getModelProviders,
  createModelProvider,
  updateModelProvider,
  deleteModelProvider,
  testModelProvider,
  type ModelProviderResponse,
} from "@/lib/api";

interface ModelProvidersTabProps {
  workspaceId: string;
}

export function ModelProvidersTab({ workspaceId }: ModelProvidersTabProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<ModelProviderResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProviderResponse | null>(null);

  // Form state
  const [adapter, setAdapter] = useState("");
  const [providerName, setProviderName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Per-model API protocol overrides: modelId -> protocol
  const [modelProtocols, setModelProtocols] = useState<Record<string, string>>({});
  // Bedrock-specific
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [useDefaultCredentials, setUseDefaultCredentials] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["model-providers", workspaceId],
    queryFn: () => getModelProviders(workspaceId),
  });

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createModelProvider>[1]) =>
      createModelProvider(workspaceId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-providers", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["llm-models", workspaceId] });
      closeDialog();
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : "Failed to save"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof updateModelProvider>[2]) =>
      updateModelProvider(workspaceId, id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-providers", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["llm-models", workspaceId] });
      closeDialog();
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : "Failed to save"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteModelProvider(workspaceId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-providers", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["llm-models", workspaceId] });
      setDeleteTarget(null);
    },
  });

  const testMutation = useMutation({
    mutationFn: (input: Parameters<typeof testModelProvider>[1]) =>
      testModelProvider(workspaceId, input),
    onSuccess: (result) => setTestResult(result),
  });

  function closeDialog() {
    setDialogOpen(false);
    setEditProvider(null);
    resetForm();
  }

  function resetForm() {
    setAdapter("");
    setProviderName("");
    setApiKey("");
    setBaseUrl("");
    setCustomModels([]);
    setModelProtocols({});
    setTestResult(null);
    setSaveError(null);
    setAwsAccessKeyId("");
    setAwsSecretAccessKey("");
    setAwsRegion("us-east-1");
    setUseDefaultCredentials(false);
  }

  function openAddDialog() {
    setEditProvider(null);
    resetForm();
    setDialogOpen(true);
  }

  function openEditDialog(p: ModelProviderResponse) {
    setEditProvider(p);
    setAdapter(p.adapter);
    setProviderName(p.provider);
    setApiKey("");
    setBaseUrl(p.baseUrl || "");
    setCustomModels(p.customModels || []);
    setModelProtocols(
      ((p.config as Record<string, unknown>)?.modelProtocols as Record<string, string>) || {},
    );
    setTestResult(null);
    setAwsAccessKeyId("");
    setAwsSecretAccessKey("");
    setAwsRegion((p.config as Record<string, string>)?.awsRegion || "us-east-1");
    setUseDefaultCredentials(false);
    setDialogOpen(true);
  }

  function handleSave() {
    setSaveError(null);
    // Build config with per-model protocol overrides (only non-default ones)
    const defaultProtocol = ADAPTER_API_PROTOCOL[adapter] || "";
    const trimmedModels = customModels.map((m) => m.trim()).filter(Boolean);
    const filteredProtocols: Record<string, string> = {};
    for (const modelId of trimmedModels) {
      const proto = modelProtocols[modelId];
      if (proto && proto !== defaultProtocol) {
        filteredProtocols[modelId] = proto;
      }
    }
    const config: Record<string, unknown> = {};
    if (Object.keys(filteredProtocols).length > 0) config.modelProtocols = filteredProtocols;

    const base: Record<string, unknown> = {
      adapter,
      provider: providerName,
      baseUrl: baseUrl || undefined,
      customModels: trimmedModels,
      withDefaultModels: true,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };

    if (adapterConfig?.credentialType === "aws") {
      base.awsRegion = awsRegion;
      if (useDefaultCredentials) {
        base.useDefaultCredentials = true;
      } else {
        base.awsAccessKeyId = awsAccessKeyId;
        base.awsSecretAccessKey = awsSecretAccessKey;
      }
    } else {
      if (apiKey) base.apiKey = apiKey;
    }

    if (editProvider) {
      updateMutation.mutate({
        id: editProvider.id,
        ...base,
      } as any);
    } else {
      createMutation.mutate(base as any);
    }
  }

  function handleTest() {
    const testData: Record<string, unknown> = { adapter };
    if (adapterConfig?.credentialType === "aws") {
      testData.awsRegion = awsRegion;
      if (useDefaultCredentials) {
        testData.useDefaultCredentials = true;
      } else {
        testData.awsAccessKeyId = awsAccessKeyId;
        testData.awsSecretAccessKey = awsSecretAccessKey;
      }
    } else if (apiKey) {
      testData.apiKey = apiKey;
    } else if (editProvider) {
      // Use stored key from DB
      testData.providerId = editProvider.id;
    }
    if (baseUrl) testData.baseUrl = baseUrl;
    setTestResult(null);
    testMutation.mutate(testData as any);
  }

  function handleAdapterChange(value: string) {
    const prevConfig = adapter ? ADAPTER_CONFIG[adapter] : null;
    setAdapter(value);
    const config = ADAPTER_CONFIG[value];
    // Auto-fill provider name if empty or still matches previous adapter's default label
    if (config && (!providerName || providerName === prevConfig?.label)) {
      setProviderName(config.label);
    }
    setModelProtocols({});
  }

  function addCustomModel() {
    const curatedModels = ADAPTER_MODELS[adapter as LLMAdapter];
    if (curatedModels) {
      const used = new Set(customModels);
      const next = curatedModels.find((m) => !used.has(m.id));
      setCustomModels([...customModels, next?.id ?? ""]);
    } else {
      setCustomModels([...customModels, ""]);
    }
  }

  function removeCustomModel(index: number) {
    setCustomModels(customModels.filter((_, i) => i !== index));
  }

  function updateCustomModel(index: number, value: string) {
    const updated = [...customModels];
    updated[index] = value;
    setCustomModels(updated);
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  // Upgrade prompt if BYOK is not enabled
  if (data && !data.byokEnabled) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">Model Providers</h2>
          <p className="text-sm text-muted-foreground">Configure your own LLM API keys</p>
        </div>
        <div className="border">
          <div className="flex flex-col items-center gap-3 px-4 py-8">
            <p className="text-center text-sm text-muted-foreground">
              Bring Your Own Key (BYOK) lets you configure your own LLM API keys for this workspace.
              Available on Pro and Startups plans.
            </p>
            <Button
              variant="default"
              size="sm"
              onClick={() => (window.location.href = `/workspaces/${workspaceId}/settings/billing`)}
            >
              Upgrade Plan
              <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const providers = data?.providers ?? [];
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const adapterConfig = adapter ? ADAPTER_CONFIG[adapter] : null;

  // Determine if save is allowed
  const hasCredentials =
    adapterConfig?.credentialType === "aws"
      ? useDefaultCredentials || (awsAccessKeyId && awsSecretAccessKey)
      : editProvider
        ? true // existing key is kept
        : !!apiKey;
  const hasRequiredBaseUrl = adapterConfig?.requiresBaseUrl ? !!baseUrl : true;
  const canSave = adapter && providerName && hasCredentials && hasRequiredBaseUrl;

  const canTest =
    adapter &&
    (adapterConfig?.credentialType === "aws"
      ? useDefaultCredentials || (awsAccessKeyId && awsSecretAccessKey)
      : !!(apiKey || editProvider));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Model Providers</h2>
          <p className="text-sm text-muted-foreground">Configure your own LLM API keys</p>
        </div>
        <AddButton onClick={openAddDialog}>Add Provider</AddButton>
      </div>

      <div className="border">
        <div className="border-b bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-medium">Configured Providers</h3>
        </div>
        {providers.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No API keys configured. Add a provider to use your own LLM keys.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10 text-left">
                <th className="px-4 py-2 font-medium text-muted-foreground">Provider</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Adapter</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Key</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Status</th>
                <th className="w-20 px-4 py-2 font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const cfg = ADAPTER_CONFIG[p.adapter];
                return (
                  <tr key={p.id} className="border-b last:border-b-0 hover:bg-muted/20">
                    <td className="px-4 py-2">{p.provider}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <ProviderIcon adapter={p.adapter} className="h-4 w-4 shrink-0" />
                        {cfg?.label ?? p.adapter}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{p.keyPreview}</td>
                    <td className="px-4 py-2">
                      <span className={p.enabled ? "text-green-600" : "text-yellow-600"}>
                        {p.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEditDialog(p)}>
                          Edit
                        </Button>
                        <DeleteIconButton onClick={() => setDeleteTarget(p)} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editProvider ? "Edit Provider" : "Add Provider"}</DialogTitle>
            <DialogDescription>
              {editProvider
                ? "Update the provider configuration."
                : "Configure an LLM provider with your own API key."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Adapter selector */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Adapter</label>
              <Select value={adapter} onValueChange={handleAdapterChange} disabled={!!editProvider}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an adapter" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ADAPTER_CONFIG).map(([key, cfg]) => (
                    <SelectItem
                      key={key}
                      value={key}
                      icon={<ProviderIcon adapter={key} className="h-4 w-4" />}
                    >
                      {cfg.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Provider name (user label) */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Provider Name</label>
              <Input
                value={providerName}
                onChange={(e) => setProviderName(e.target.value)}
                placeholder="e.g. My OpenAI, Production DeepSeek"
              />
              <p className="text-xs text-muted-foreground">
                A unique name for this provider in your workspace.
              </p>
            </div>

            {/* Credentials — conditional on adapter type */}
            {adapterConfig?.credentialType === "aws" ? (
              <div className="space-y-3">
                <label className="text-sm font-medium">AWS Credentials</label>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="useDefaultCreds"
                    checked={useDefaultCredentials}
                    onChange={(e) => setUseDefaultCredentials(e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="useDefaultCreds" className="text-sm">
                    Use default AWS credential chain
                  </label>
                </div>
                {!useDefaultCredentials && (
                  <>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Access Key ID</label>
                      <Input
                        value={awsAccessKeyId}
                        onChange={(e) => setAwsAccessKeyId(e.target.value)}
                        placeholder="AKIA..."
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Secret Access Key</label>
                      <Input
                        type="password"
                        value={awsSecretAccessKey}
                        onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                        placeholder="Secret key"
                      />
                    </div>
                  </>
                )}
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Region</label>
                  <Input
                    value={awsRegion}
                    onChange={(e) => setAwsRegion(e.target.value)}
                    placeholder="us-east-1"
                  />
                </div>
              </div>
            ) : adapterConfig ? (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  API Key{editProvider ? " (leave blank to keep current)" : ""}
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder={editProvider ? editProvider.keyPreview : "sk-..."}
                />
              </div>
            ) : null}

            {/* Base URL — hidden for Bedrock (uses AWS regions, not URLs) */}
            {adapterConfig && adapterConfig.credentialType !== "aws" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Base URL{adapterConfig.requiresBaseUrl ? "" : " (optional)"}
                </label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={
                    adapterConfig.requiresBaseUrl
                      ? "https://your-resource.openai.azure.com"
                      : ADAPTER_DEFAULT_BASE_URL[adapter]
                        ? `Default: ${ADAPTER_DEFAULT_BASE_URL[adapter]}`
                        : "Leave blank for default"
                  }
                />
              </div>
            )}

            {/* Models */}
            {adapterConfig && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Models</label>
                  <Button type="button" variant="outline" size="sm" onClick={addCustomModel}>
                    <Plus className="mr-1 h-3 w-3" />
                    Add Model
                  </Button>
                </div>

                {(() => {
                  const protocols = ADAPTER_AVAILABLE_PROTOCOLS[adapter];
                  const hasMultipleProtocols = protocols && protocols.length > 1;
                  const defaultProto = ADAPTER_API_PROTOCOL[adapter] || "";
                  const curatedModels = ADAPTER_MODELS[adapter as LLMAdapter];

                  return customModels.map((model, i) => (
                    <div key={i} className="flex items-center gap-2">
                      {curatedModels ? (
                        <Select
                          value={model}
                          onValueChange={(v) => updateCustomModel(i, v)}
                        >
                          <SelectTrigger className="flex-1">
                            <SelectValue placeholder="Select a model" />
                          </SelectTrigger>
                          <SelectContent>
                            {curatedModels
                              .filter((m) => m.id === model || !customModels.includes(m.id))
                              .map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  {m.label}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={model}
                          onChange={(e) => updateCustomModel(i, e.target.value)}
                          placeholder={
                            {
                              azure: "e.g. my-gpt4-deployment",
                              "amazon-bedrock": "e.g. anthropic.claude-v2",
                              openrouter: "e.g. openai/gpt-4o",
                            }[adapter] || "Model ID"
                          }
                          className="flex-1"
                        />
                      )}
                      {hasMultipleProtocols && (
                        <Select
                          value={modelProtocols[model] || defaultProto}
                          onValueChange={(v) =>
                            setModelProtocols((prev) => ({ ...prev, [model]: v }))
                          }
                        >
                          <SelectTrigger className="w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {protocols.map((p) => (
                              <SelectItem key={p.value} value={p.value}>
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeCustomModel(i)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ));
                })()}

                {customModels.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Add model IDs you want to use with this provider.
                  </p>
                )}
              </div>
            )}

            {/* Test Connection */}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canTest || testMutation.isPending}
                onClick={handleTest}
              >
                {testMutation.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Test Connection
              </Button>
              {testResult && (
                <span className="flex items-center gap-1 text-xs">
                  {testResult.success ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                      <span className="text-green-600">Connected</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3.5 w-3.5 text-destructive" />
                      <span className="text-destructive">{testResult.error}</span>
                    </>
                  )}
                </span>
              )}
            </div>
          </div>

          {saveError && (
            <div className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              {saveError}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!canSave || isSaving}>
              {isSaving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {editProvider ? "Update" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Provider</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {deleteTarget?.provider}? Models from this provider
              will no longer be available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
