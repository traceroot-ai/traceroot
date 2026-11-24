"use client";

import { useId, useState } from "react";
import { ImpersonationError } from "@/lib/api/errors";
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
import { useT } from "@/lib/i18n/provider";
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
  const formId = useId();
  const t = useT();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyData, setNewKeyData] = useState<{ key: string; keyHint: string } | null>(null);
  const [editingKey, setEditingKey] = useState<{ id: string; name: string } | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<AccessKey | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const { data, isLoading, error } = useQuery({
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

  const envBlockContent = newKeyData
    ? `TRACEROOT_API_KEY="${newKeyData.key}"`
    : accessKeys.length > 0
      ? `TRACEROOT_API_KEY="${formatKeyHint(accessKeys[0].key_hint)}"`
      : `TRACEROOT_API_KEY="tr-..."`;

  if (error instanceof ImpersonationError) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {error.message}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="-mx-4 -mt-4 flex h-11 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[15px] font-medium">{t("accessKeys.title")}</h2>
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <AddButton
          onClick={() => {
            createMutation.reset();
            setShowCreateDialog(true);
          }}
        >
          {t("accessKeys.createNew")}
        </AddButton>
      </div>

      <div className="border">
        <div className="flex h-9 items-center justify-between border-b px-4">
          <span className="text-[13px] font-medium">.env</span>
          <CopyButton
            aria-label={t("accessKeys.copyEnv")}
            value={envBlockContent}
            className="h-7 w-7"
          />
        </div>
        <div className="bg-muted px-4 py-2.5 font-mono text-[12px]">
          <pre className="whitespace-pre-wrap">{envBlockContent}</pre>
        </div>
      </div>

      {newKeyData && (
        <div className="border border-success-border bg-success-soft">
          <div className="px-4 py-3">
            <p className="mb-2 text-xs font-medium text-success">{t("accessKeys.createdNotice")}</p>
            <div className="mb-2 flex items-center gap-2">
              <code className="flex-1 border bg-white px-2 py-1.5 font-mono text-xs dark:bg-black">
                {newKeyData.key}
              </code>
              <CopyButton
                aria-label={t("accessKeys.copyKey")}
                value={newKeyData.key}
                variant="outline"
              />
            </div>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleCloseNewKey}>
              {t("accessKeys.copiedKey")}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("accessKeys.createTitle")}</DialogTitle>
            <DialogDescription>{t("accessKeys.createDescription")}</DialogDescription>
          </DialogHeader>
          <div>
            <label htmlFor={`${formId}-key-name`} className="mb-2 block text-sm font-medium">
              {t("accessKeys.nameOptional")}
            </label>
            <Input
              placeholder={t("accessKeys.namePlaceholder")}
              id={`${formId}-key-name`}
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>
          {createMutation.error instanceof ImpersonationError && (
            <p role="alert" className="text-sm text-destructive">
              {createMutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingKey} onOpenChange={(open) => !open && setEditingKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("accessKeys.editNoteTitle")}</DialogTitle>
            <DialogDescription>{t("accessKeys.editNoteDescription")}</DialogDescription>
          </DialogHeader>
          <div>
            <Input
              placeholder={t("accessKeys.namePlaceholder")}
              aria-label={t("accessKeys.note")}
              value={editingKey?.name || ""}
              onChange={(e) =>
                setEditingKey(editingKey ? { ...editingKey, name: e.target.value } : null)
              }
              onKeyDown={(e) => e.key === "Enter" && handleSaveNote()}
            />
          </div>
          {updateMutation.error instanceof ImpersonationError && (
            <p role="alert" className="text-sm text-destructive">
              {updateMutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingKey(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSaveNote} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? t("common.saving") : t("common.save")}
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
            <DialogTitle>{t("accessKeys.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("accessKeys.deleteBefore")}
              <span className="font-semibold">
                {keyToDelete?.name || formatKeyHint(keyToDelete?.key_hint || "")}
              </span>
              {t("accessKeys.deleteAfter")}
            </DialogDescription>
          </DialogHeader>
          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              {t("workspaceSettings.typeBefore")}{" "}
              <span className="font-mono font-semibold text-foreground">
                {keyToDelete?.name || "delete"}
              </span>{" "}
              {t("workspaceSettings.typeAfter")}
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={
                keyToDelete?.name ? t("accessKeys.keyNamePlaceholder") : t("shellCommon.typeDelete")
              }
              className="h-8 text-[13px]"
            />
          </div>
          {deleteMutation.error instanceof ImpersonationError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteMutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setKeyToDelete(null)}>
              {t("common.cancel")}
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
              {deleteMutation.isPending
                ? t("workspaceSettings.deleting")
                : t("accessKeys.deleteTitle")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="border">
        {isLoading ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">
            {t("accessKeys.loading")}
          </div>
        ) : accessKeys.length === 0 ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">{t("accessKeys.empty")}</div>
        ) : (
          <table className="data-table w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  {t("common.name")}
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  {t("shellCommon.key")}
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  {t("common.created")}
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  {t("accessKeys.lastUsed")}
                </th>
                <th className="w-10 px-3 py-2 text-[12px] font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
              {accessKeys.map((key: AccessKey) => (
                <tr key={key.id} className="border-b last:border-b-0 hover:bg-muted">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => {
                        updateMutation.reset();
                        setEditingKey({ id: key.id, name: key.name || "" });
                      }}
                      className="cursor-pointer text-left hover:underline"
                    >
                      {key.name || <span className="text-muted-foreground">-</span>}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <code className="bg-muted px-1.5 py-0.5 font-mono text-[12px]">
                      {formatKeyHint(key.key_hint)}
                    </code>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatRelativeTime(key.create_time)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {key.last_use_time
                      ? formatRelativeTime(key.last_use_time)
                      : t("accessKeys.never")}
                  </td>
                  <td className="px-3 py-2">
                    <DeleteIconButton
                      aria-label={t("accessKeys.deleteKey", {
                        name: key.name || formatKeyHint(key.key_hint),
                      })}
                      className="h-6 w-6"
                      onClick={() => {
                        deleteMutation.reset();
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
