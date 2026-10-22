"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, XCircle, Info } from "lucide-react";
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
  getCustomModelPrices,
  createCustomModelPrice,
  updateCustomModelPrice,
  deleteCustomModelPrice,
  type CustomModelPrice,
} from "@/lib/api";

interface CustomPricingTabProps {
  workspaceId: string;
}

function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  return `$${rate.toFixed(4)} / 1M`;
}

export function CustomPricingTab({ workspaceId }: CustomPricingTabProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editPrice, setEditPrice] = useState<CustomModelPrice | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomModelPrice | null>(null);

  // Form state
  const [modelName, setModelName] = useState("");
  const [matchPattern, setMatchPattern] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [cacheReadPrice, setCacheReadPrice] = useState("");
  const [cacheWritePrice, setCacheWritePrice] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["custom-model-prices", workspaceId],
    queryFn: () => getCustomModelPrices(workspaceId),
  });

  const createMutation = useMutation({
    mutationFn: (payload: Parameters<typeof createCustomModelPrice>[1]) =>
      createCustomModelPrice(workspaceId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-model-prices", workspaceId] });
      closeDialog();
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : "Failed to save"),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      ...payload
    }: { id: string } & Parameters<typeof updateCustomModelPrice>[2]) =>
      updateCustomModelPrice(workspaceId, id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-model-prices", workspaceId] });
      closeDialog();
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : "Failed to update"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCustomModelPrice(workspaceId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-model-prices", workspaceId] });
      setDeleteTarget(null);
    },
  });

  function resetForm() {
    setModelName("");
    setMatchPattern("");
    setInputPrice("");
    setOutputPrice("");
    setCacheReadPrice("");
    setCacheWritePrice("");
    setSaveError(null);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditPrice(null);
    resetForm();
  }

  function openAddDialog() {
    setEditPrice(null);
    resetForm();
    setDialogOpen(true);
  }

  function openEditDialog(item: CustomModelPrice) {
    setEditPrice(item);
    setModelName(item.modelName);
    setMatchPattern(item.matchPattern || "");
    setInputPrice(String(item.inputPrice));
    setOutputPrice(String(item.outputPrice));
    setCacheReadPrice(item.cacheReadPrice !== null ? String(item.cacheReadPrice) : "");
    setCacheWritePrice(item.cacheWritePrice !== null ? String(item.cacheWritePrice) : "");
    setSaveError(null);
    setDialogOpen(true);
  }

  function handleSave() {
    setSaveError(null);
    const trimmedName = modelName.trim();
    if (!trimmedName) {
      setSaveError("Model name is required");
      return;
    }

    const parsedInput = parseFloat(inputPrice);
    if (isNaN(parsedInput) || parsedInput < 0) {
      setSaveError("Input price must be a valid number >= 0");
      return;
    }

    const parsedOutput = parseFloat(outputPrice);
    if (isNaN(parsedOutput) || parsedOutput < 0) {
      setSaveError("Output price must be a valid number >= 0");
      return;
    }

    let parsedCacheRead: number | undefined = undefined;
    if (cacheReadPrice.trim()) {
      parsedCacheRead = parseFloat(cacheReadPrice);
      if (isNaN(parsedCacheRead) || parsedCacheRead < 0) {
        setSaveError("Cache read price must be a valid number >= 0");
        return;
      }
    }

    let parsedCacheWrite: number | undefined = undefined;
    if (cacheWritePrice.trim()) {
      parsedCacheWrite = parseFloat(cacheWritePrice);
      if (isNaN(parsedCacheWrite) || parsedCacheWrite < 0) {
        setSaveError("Cache write price must be a valid number >= 0");
        return;
      }
    }

    const trimmedPattern = matchPattern.trim() || undefined;
    if (trimmedPattern) {
      try {
        new RegExp(trimmedPattern);
      } catch {
        setSaveError("Match pattern must be a valid regular expression");
        return;
      }
    }

    if (editPrice) {
      updateMutation.mutate({
        id: editPrice.id,
        modelName: trimmedName,
        matchPattern: trimmedPattern ?? null,
        inputPrice: parsedInput,
        outputPrice: parsedOutput,
        cacheReadPrice: parsedCacheRead ?? null,
        cacheWritePrice: parsedCacheWrite ?? null,
      });
    } else {
      createMutation.mutate({
        modelName: trimmedName,
        matchPattern: trimmedPattern,
        inputPrice: parsedInput,
        outputPrice: parsedOutput,
        cacheReadPrice: parsedCacheRead,
        cacheWritePrice: parsedCacheWrite,
      });
    }
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading custom model prices...</div>;
  }

  const prices = data?.prices ?? [];
  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Model Pricing</h2>
          <p className="text-sm text-muted-foreground">
            Configure custom token rates for fine-tuned, self-hosted, or unlisted models.
          </p>
        </div>
        <AddButton onClick={openAddDialog}>Add Custom Price</AddButton>
      </div>

      <div className="flex items-start gap-2.5 rounded-md border bg-muted/20 p-3.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <span>
            Rates are entered in <strong>USD per million tokens</strong> ($/1M). Custom prices take
            precedence over TraceRoot&apos;s standard catalog for spans ingested in this workspace.
            Cost hierarchy: (1) Caller/instrumentor supplied cost, (2) Workspace custom price, (3)
            Standard catalog, (4) Fallback estimation.
          </span>
        </div>
      </div>

      <div className="border">
        <div className="border-b bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-medium">Configured Model Prices</h3>
        </div>
        {prices.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No custom model prices configured. Add a price to track costs for models not listed in
            TraceRoot&apos;s standard pricing table.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10 text-left">
                <th className="px-4 py-2 font-medium text-muted-foreground">Model / Name</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Match Pattern</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Input ($/1M)</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Output ($/1M)</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Cache Read ($/1M)</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Cache Write ($/1M)</th>
                <th className="w-20 px-4 py-2 font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-4 py-2 font-mono text-xs font-medium">{p.modelName}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {p.matchPattern ? (
                      p.matchPattern
                    ) : (
                      <span className="font-sans italic">Exact match</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{formatRate(p.inputPrice)}</td>
                  <td className="px-4 py-2">{formatRate(p.outputPrice)}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {formatRate(p.cacheReadPrice)}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {formatRate(p.cacheWritePrice)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEditDialog(p)}>
                        Edit
                      </Button>
                      <DeleteIconButton
                        aria-label="Delete"
                        onClick={() => {
                          deleteMutation.reset();
                          setDeleteTarget(p);
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editPrice ? "Edit Model Price" : "Add Custom Model Price"}</DialogTitle>
            <DialogDescription>
              {editPrice
                ? "Update pricing rates for this model."
                : "Set pricing rates for a model name or regex pattern."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Model Name</label>
              <Input
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="e.g. meta-llama/Llama-3.3-70B-Instruct"
              />
              <p className="text-xs text-muted-foreground">
                The reported model identifier or a human-friendly name.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Match Pattern (optional regex)</label>
              <Input
                value={matchPattern}
                onChange={(e) => setMatchPattern(e.target.value)}
                placeholder="e.g. ^meta-llama/Llama-3\\.3-.*"
              />
              <p className="text-xs text-muted-foreground">
                Optional regex to match dynamic model prefixes or versions. If blank, exact match on
                model name is used.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Input Price ($ / 1M tokens)</label>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={inputPrice}
                  onChange={(e) => setInputPrice(e.target.value)}
                  placeholder="0.80"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Output Price ($ / 1M tokens)</label>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={outputPrice}
                  onChange={(e) => setOutputPrice(e.target.value)}
                  placeholder="2.40"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Cache Read Price (optional, $/1M)</label>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={cacheReadPrice}
                  onChange={(e) => setCacheReadPrice(e.target.value)}
                  placeholder="0.20"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Cache Write Price (optional, $/1M)</label>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={cacheWritePrice}
                  onChange={(e) => setCacheWritePrice(e.target.value)}
                  placeholder="1.00"
                />
              </div>
            </div>
          </div>

          {saveError && (
            <div className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {editPrice ? "Update" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            deleteMutation.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Model Price</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete custom pricing for{" "}
              <span className="font-mono font-medium">{deleteTarget?.modelName}</span>? Future spans
              for this model will fall back to standard catalog pricing or estimation.
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
