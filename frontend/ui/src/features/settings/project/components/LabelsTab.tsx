"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableEmpty, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";
import {
  createProjectLabel,
  deleteProjectLabel,
  updateProjectLabel,
  type ProjectLabel,
} from "@/features/labels/api";
import {
  projectLabelsKey,
  useCanManageProjectLabels,
  useProjectLabels,
} from "@/features/labels/queries";
import { DatasetActionsMenu } from "@/features/offline-eval/components/dataset-actions-menu";

interface LabelDraft {
  id?: string;
  name: string;
  description: string;
}

export function LabelsTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data: labels, isPending, isError } = useProjectLabels(projectId);
  const canManage = useCanManageProjectLabels(projectId);
  const columnCount = canManage ? 3 : 2;
  const [draft, setDraft] = useState<LabelDraft | null>(null);
  const [labelToDelete, setLabelToDelete] = useState<Pick<ProjectLabel, "id" | "name"> | null>(
    null,
  );

  const save = useMutation({
    mutationFn: ({ id, name, description }: LabelDraft) =>
      id
        ? updateProjectLabel(projectId, id, description.trim())
        : createProjectLabel(projectId, name.trim(), description.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectLabelsKey(projectId) });
      setDraft(null);
    },
  });

  const remove = useMutation({
    mutationFn: (labelId: string) => deleteProjectLabel(projectId, labelId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectLabelsKey(projectId) }),
        queryClient.invalidateQueries({ queryKey: ["trace-labels", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["traces", projectId] }),
      ]);
      setLabelToDelete(null);
    },
  });

  function editLabel(nextDraft: LabelDraft) {
    save.reset();
    setDraft(nextDraft);
  }

  function closeDialog() {
    if (!save.isPending) setDraft(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canManage && draft?.name.trim() && !save.isPending) save.mutate(draft);
  }

  function closeDeleteDialog() {
    if (!remove.isPending) setLabelToDelete(null);
  }

  return (
    <div>
      <div className="-mx-4 -mt-4 flex h-11 items-center justify-between gap-3 border-b border-border px-4">
        <h2 className="text-[15px] font-medium">Labels</h2>
        {canManage && (
          <Button
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={() => editLabel({ name: "", description: "" })}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Create label
          </Button>
        )}
      </div>

      <div className="-mx-4">
        <Table aria-label="Labels" className="table-fixed">
          <THead>
            <TRHead>
              <Th className="w-1/3">Name</Th>
              <Th>Description</Th>
              {canManage && (
                <Th className="w-[56px] text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              )}
            </TRHead>
          </THead>
          <TBody>
            {isPending ? (
              <TableEmpty colSpan={columnCount}>Loading labels…</TableEmpty>
            ) : isError ? (
              <TableEmpty colSpan={columnCount}>
                <span role="alert" className="text-destructive">
                  Could not load labels.
                </span>
              </TableEmpty>
            ) : labels.length ? (
              labels.map((label) => (
                <TR key={label.id} className="hover:bg-muted">
                  <Td>
                    <span className="block truncate" title={label.name}>
                      {label.name}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">
                    <span className="block truncate" title={label.description ?? undefined}>
                      {label.description || "–"}
                    </span>
                  </Td>
                  {canManage && (
                    <Td className="text-right">
                      <DatasetActionsMenu
                        onEdit={() => editLabel({ ...label, description: label.description ?? "" })}
                        onDelete={() => {
                          remove.reset();
                          setLabelToDelete(label);
                        }}
                      />
                    </Td>
                  )}
                </TR>
              ))
            ) : (
              <TableEmpty colSpan={columnCount}>No project labels yet.</TableEmpty>
            )}
          </TBody>
        </Table>
      </div>

      <Dialog open={!!draft && canManage} onOpenChange={(open) => !open && closeDialog()}>
        {draft && (
          <DialogContent className="max-w-sm">
            <form className="space-y-4" onSubmit={submit}>
              <DialogHeader>
                <DialogTitle>{draft.id ? "Edit label" : "Create label"}</DialogTitle>
                <DialogDescription className="text-[12px]">
                  Label names stay fixed once created.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <label htmlFor="project-label-name" className="text-[13px] font-medium">
                  Name
                </label>
                <Input
                  id="project-label-name"
                  value={draft.name}
                  required
                  readOnly={!!draft.id}
                  disabled={save.isPending}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="project-label-description" className="text-[13px] font-medium">
                  Description <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="project-label-description"
                  value={draft.description}
                  disabled={save.isPending}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </div>
              {save.isError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {save.error.message}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeDialog}
                  disabled={save.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!draft.name.trim() || save.isPending}>
                  {save.isPending ? "Saving…" : draft.id ? "Save" : "Create"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={!!labelToDelete && canManage}
        onOpenChange={(open) => !open && closeDeleteDialog()}
      >
        {labelToDelete && (
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete label</DialogTitle>
              <DialogDescription className="text-[13px]">
                Deleting <span className="font-medium text-foreground">{labelToDelete.name}</span>{" "}
                removes it from this project and from every trace and span where it was applied.
                This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {remove.isError && (
              <p role="alert" className="text-[13px] text-destructive">
                {remove.error.message}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDeleteDialog}
                disabled={remove.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  if (canManage && !remove.isPending) remove.mutate(labelToDelete.id);
                }}
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
