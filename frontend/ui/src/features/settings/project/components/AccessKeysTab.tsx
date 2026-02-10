"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddButton } from "@/components/ui/add-button";
import { DeleteIconButton } from "@/components/ui/delete-button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
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

  const envBlockContent = newKeyData
    ? `TRACEROOT_API_KEY = "${newKeyData.key}"`
    : accessKeys.length > 0
      ? `TRACEROOT_API_KEY = "${formatKeyHint(accessKeys[0].key_hint)}"`
      : `TRACEROOT_API_KEY = "tr-..."`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h2 className="text-lg font-semibold">Project API Keys</h2>
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <AddButton onClick={() => setShowCreateDialog(true)}>Create new API key</AddButton>
      </div>

      <div className="border">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-xs text-muted-foreground">.env</span>
          <CopyButton value={envBlockContent} className="h-6 w-6" />
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
              <CopyButton value={newKeyData.key} variant="outline" />
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
              Create a new API key to authenticate with the Traceroot SDK.
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
                      onClick={() => deleteMutation.mutate(key.id)}
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
