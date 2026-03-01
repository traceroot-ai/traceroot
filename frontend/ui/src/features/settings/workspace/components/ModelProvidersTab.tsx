"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Loader2, CheckCircle2, XCircle, ArrowUpRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ADAPTER_CONFIG, DEFAULT_MODELS } from "@traceroot/core";
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
    setTestResult(null);
    setAwsAccessKeyId("");
    setAwsSecretAccessKey("");
    setAwsRegion((p.config as Record<string, string>)?.awsRegion || "us-east-1");
    setUseDefaultCredentials(false);
    setDialogOpen(true);
  }

  function handleSave() {
    setSaveError(null);
    const base: Record<string, unknown> = {
      adapter,
      provider: providerName,
      baseUrl: baseUrl || undefined,
      customModels,
      withDefaultModels: true,
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
    } else {
      testData.apiKey = apiKey;
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
  }

  function addCustomModel() {
    setCustomModels([...customModels, ""]);
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
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Model Providers</h2>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8">
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
          </CardContent>
        </Card>
      </div>
    );
  }

  const providers = data?.providers ?? [];
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const adapterConfig = adapter ? ADAPTER_CONFIG[adapter] : null;
  const hasDefaults = adapter ? (DEFAULT_MODELS[adapter] || []).length > 0 : false;

  // Determine if save is allowed
  const hasCredentials =
    adapterConfig?.credentialType === "aws"
      ? useDefaultCredentials || (awsAccessKeyId && awsSecretAccessKey)
      : editProvider
        ? true // existing key is kept
        : !!apiKey;
  const hasRequiredBaseUrl = adapterConfig?.requiresBaseUrl ? !!baseUrl : true;
  const hasRequiredCustomModels =
    adapterConfig?.requiresCustomModels && !hasDefaults
      ? customModels.filter(Boolean).length > 0
      : true;
  const canSave =
    adapter && providerName && hasCredentials && hasRequiredBaseUrl && hasRequiredCustomModels;

  const canTest =
    adapter &&
    (adapterConfig?.credentialType === "aws"
      ? useDefaultCredentials || (awsAccessKeyId && awsSecretAccessKey)
      : !!apiKey);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Model Providers</h2>
        <Button size="sm" onClick={openAddDialog}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add Provider
        </Button>
      </div>

      {providers.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No API keys configured. Add a provider to use your own LLM keys.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => {
            const cfg = ADAPTER_CONFIG[p.adapter];
            const allModels = p.customModels || [];
            return (
              <Card key={p.id}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    {p.provider}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {cfg?.label ?? p.adapter}
                    </span>
                  </CardTitle>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEditDialog(p)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(p)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>Key: {p.keyPreview}</span>
                    <span className={p.enabled ? "text-green-600" : "text-yellow-600"}>
                      {p.enabled ? "Enabled" : "Disabled"}
                    </span>
                    {p.baseUrl && <span>URL: {p.baseUrl}</span>}
                    {allModels.length > 0 && <span>Custom models: {allModels.join(", ")}</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

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
                    <SelectItem key={key} value={key}>
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

            {/* Base URL — shown for adapters that support it */}
            {adapterConfig && (
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
                      : "Leave blank for default"
                  }
                />
              </div>
            )}

            {/* Custom Models */}
            {adapterConfig && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Models</label>
                  <Button type="button" variant="outline" size="sm" onClick={addCustomModel}>
                    <Plus className="mr-1 h-3 w-3" />
                    Add Model
                  </Button>
                </div>

                {/* Custom model inputs */}
                {customModels.map((model, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={model}
                      onChange={(e) => updateCustomModel(i, e.target.value)}
                      placeholder="Model ID (e.g. gpt-4-deployment)"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeCustomModel(i)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}

                {adapterConfig.requiresCustomModels &&
                  !hasDefaults &&
                  customModels.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      This adapter requires at least one custom model ID.
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
