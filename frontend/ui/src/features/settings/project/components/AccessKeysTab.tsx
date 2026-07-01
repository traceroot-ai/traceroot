"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddButton } from "@/components/ui/add-button";
import { DeleteIconButton } from "@/components/ui/delete-button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatRelativeTime } from "@/lib/utils";
import {
  getAccessKeys,
  createAccessKey,
  updateAccessKey,
  deleteAccessKey,
  type AccessKey,
} from "@/lib/api";

interface AccessKeysTabProps {
  projectId: string;
}

const PROJECT_API_KEYS_HELP_TEXT =
  "Project API keys authenticate TraceRoot SDK and API requests for this project. When you create a new key, copy the full secret immediately and store it as TRACEROOT_API_KEY. Later, only a masked hint is shown.";

function formatKeyHint(keyHint: string): string {
  if (keyHint.startsWith("tr-")) {
    const rest = keyHint.slice(3);
    if (rest.length > 8) {
      return `tr-${rest.slice(0, 4)}...${rest.slice(-4)}`;
    }
    return keyHint;
  }
  return keyHint;
}

export function AccessKeysTab({ projectId }: AccessKeysTabProps) {
  const queryClient = useQueryClient();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyData, setNewKeyData] = useState<{ key: string; keyHint: string } | null>(null);
  const [editingKey, setEditingKey] = useState<{ id: string; name: string } | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<AccessKey | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["access-keys", projectId],
    queryFn: () => getAccessKeys(projectId),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => createAccessKey(projectId, name || undefined),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["access-keys", projectId] });
      setNewKeyData({ key: response.data.key, keyHint: response.data.key_hint });
      setNewKeyName("");
      setShowCreateDialog(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ keyId, name }: { keyId: string; name: string | null }) =>
      updateAccessKey(projectId, keyId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-keys", projectId] });
      setEditingKey(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => deleteAccessKey(projectId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-keys", projectId] });
      setKeyToDelete(null);
      setDeleteConfirmText("");
    },
  });

  const handleCreate = () => {
    createMutation.mutate(newKeyName);
  };

  const handleCloseNewKey = () => {
    setNewKeyData(null);
  };

  const handleSaveNote = () => {
    if (editingKey) {
      updateMutation.mutate({ keyId: editingKey.id, name: editingKey.name || null });
    }
  };

  const accessKeys = data?.access_keys || [];

  const hasCopyableEnvValue = !!newKeyData;
  const envBlockContent = hasCopyableEnvValue
    ? `TRACEROOT_API_KEY = "${newKeyData.key}"`
    : accessKeys.length > 0
      ? `TRACEROOT_API_KEY = "${formatKeyHint(accessKeys[0].key_hint)}"`
      : `TRACEROOT_API_KEY = "tr-..."`;
  const envBlockLabel = hasCopyableEnvValue
    ? ".env"
    : accessKeys.length > 0
      ? ".env masked hint"
      : ".env example";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h2 className="text-lg font-semibold">Project API Keys</h2>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="About Project API Keys"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Info aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-left">
                {PROJECT_API_KEYS_HELP_TEXT}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <AddButton onClick={() => setShowCreateDialog(true)}>Create new API key</AddButton>
      </div>

      <div className="border">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-xs text-muted-foreground">{envBlockLabel}</span>
          <CopyButton
            value={envBlockContent}
            className="h-6 w-6"
            aria-label={
              hasCopyableEnvValue
                ? "Copy API key environment variable"
                : "Create a new API key to copy the full environment variable"
            }
            disabled={!hasCopyableEnvValue}
          />
        </div>
        <div className="bg-muted px-4 py-3 font-mono text-xs">
          <pre className="whitespace-pre-wrap">{envBlockContent}</pre>
        </div>
      </div>

      {newKeyData && (
        <div className="border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950">
          <div className="px-4 py-3">
            <p className="mb-2 text-xs font-medium text-green-800 dark:text-green-200">
              New API key created! Copy it now - you won&apos;t see it again.
            </p>
            <div className="mb-2 flex items-center gap-2">
              <code className="flex-1 border bg-white px-2 py-1.5 font-mono text-xs dark:bg-black">
                {newKeyData.key}
              </code>
              <CopyButton value={newKeyData.key} variant="outline" aria-label="Copy new API key" />
            </div>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleCloseNewKey}>
              I&apos;ve copied the key
            </Button>
          </div>
        </div>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
            <DialogDescription>
              Create a new API key to authenticate with the TraceRoot SDK.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="mb-2 block text-sm font-medium">Name (optional)</label>
            <Input
              placeholder="e.g., Production, Development"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingKey} onOpenChange={(open) => !open && setEditingKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Note</DialogTitle>
            <DialogDescription>Update the note for this API key.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g., Production, Development"
              value={editingKey?.name || ""}
              onChange={(e) =>
                setEditingKey(editingKey ? { ...editingKey, name: e.target.value } : null)
              }
              onKeyDown={(e) => e.key === "Enter" && handleSaveNote()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingKey(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveNote} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!keyToDelete}
        onOpenChange={(open) => {
          if (!open) {
            setKeyToDelete(null);
            setDeleteConfirmText("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete API Key</DialogTitle>
            <DialogDescription>
              This action cannot be undone. This will permanently delete the API key &quot;
              <span className="font-semibold">
                {keyToDelete?.name || formatKeyHint(keyToDelete?.key_hint || "")}
              </span>
              &quot;.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="mb-2 text-sm text-muted-foreground">
              Type{" "}
              <span className="font-mono font-semibold text-foreground">
                {keyToDelete?.name || "delete"}
              </span>{" "}
              to confirm:
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={keyToDelete?.name ? "API key name" : "Type 'delete'"}
              className="h-8 text-[13px]"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKeyToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (keyToDelete) {
                  deleteMutation.mutate(keyToDelete.id);
                }
              }}
              disabled={
                deleteConfirmText !== (keyToDelete?.name || "delete") || deleteMutation.isPending
              }
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete API Key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="border">
        {isLoading ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">Loading API keys...</div>
        ) : accessKeys.length === 0 ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">
            No API keys yet. Create one to start using the SDK.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b bg-muted/30 text-left">
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">Name</th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">Key</th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">Created</th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  Last Used
                </th>
                <th className="w-10 px-3 py-2 text-[12px] font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
              {accessKeys.map((key: AccessKey) => (
                <tr key={key.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setEditingKey({ id: key.id, name: key.name || "" })}
                      className="cursor-pointer text-left hover:underline"
                    >
                      {key.name || <span className="text-muted-foreground">-</span>}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <code className="bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {formatKeyHint(key.key_hint)}
                    </code>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatRelativeTime(key.create_time)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {key.last_use_time ? formatRelativeTime(key.last_use_time) : "Never"}
                  </td>
                  <td className="px-3 py-2">
                    <DeleteIconButton
                      className="h-6 w-6"
                      onClick={() => {
                        setKeyToDelete(key);
                        setDeleteConfirmText("");
                      }}
                      disabled={deleteMutation.isPending}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
