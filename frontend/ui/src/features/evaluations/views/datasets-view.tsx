"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { Timestamp } from "@/features/offline-eval/components";
import { useDatasets, useCreateDataset } from "../hooks";

/**
 * Real, server-backed Datasets list. Data comes from
 * /api/projects/[id]/datasets — never the prototype fixtures.
 */
export function DatasetsView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [keyword, setKeyword] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);

  const { data, isLoading, error } = useDatasets(projectId, {
    search_query: keyword.trim() || undefined,
  });
  const datasets = data?.data ?? [];
  const total = data?.meta?.total ?? 0;
  const isEmptyProject = !isLoading && !error && total === 0 && !keyword;
  const isEmptySearch = !isLoading && !error && datasets.length === 0 && !!keyword;

  return (
    <>
      <ProjectBreadcrumb projectId={projectId} current="Datasets" />

      <div className="flex flex-1 flex-col overflow-hidden text-[13px]">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h1 className="text-[13px] font-medium">Datasets</h1>
          <Button size="sm" className="h-7 text-[12px]" onClick={() => setCreateOpen(true)}>
            New Dataset
          </Button>
        </div>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Search datasets..."
            className="h-7 max-w-xs text-[12px]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-[13px] text-muted-foreground">Loading datasets...</p>
            </div>
          ) : error ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-[13px] text-destructive">Error loading datasets</p>
            </div>
          ) : isEmptyProject ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <Database className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-[13px] text-muted-foreground">No datasets yet</p>
              <p className="text-[12px] text-muted-foreground">
                Save a trace or span as a test case to start a dataset.
              </p>
              <Button size="sm" className="h-7 text-[12px]" onClick={() => setCreateOpen(true)}>
                New Dataset
              </Button>
            </div>
          ) : isEmptySearch ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2">
              <p className="text-[13px] text-muted-foreground">
                No datasets match &ldquo;{keyword}&rdquo;
              </p>
              <button
                className="text-[12px] text-muted-foreground underline"
                onClick={() => setKeyword("")}
              >
                Clear search
              </button>
            </div>
          ) : (
            <Table>
              <THead>
                <TRHead>
                  <Th>Name</Th>
                  <Th className="w-[110px] text-right">Test cases</Th>
                  <Th className="w-[90px] text-right">Versions</Th>
                  <Th className="w-[170px]">Updated</Th>
                </TRHead>
              </THead>
              <TBody>
                {datasets.map((d) => (
                  <TR
                    key={d.id}
                    interactive
                    onClick={() => router.push(`/projects/${projectId}/datasets/${d.id}`)}
                  >
                    <Td>
                      <span className="font-medium">{d.name}</span>
                      {d.description && (
                        <span className="ml-2 text-muted-foreground">{d.description}</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{d.caseCount}</Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {d.versionCount}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      <Timestamp iso={d.updateTime} />
                    </Td>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </div>

      <NewDatasetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={(id) => router.push(`/projects/${projectId}/datasets/${id}`)}
      />
    </>
  );
}

function NewDatasetDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const create = useCreateDataset(projectId);

  React.useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    const res = await create.mutateAsync({
      name: name.trim(),
      description: description.trim() || null,
    });
    onOpenChange(false);
    onCreated(res.dataset.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[13px] font-medium">New dataset</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[12px]">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Billing routing"
              autoFocus
              className="h-7 text-[12px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">
              Description <span className="font-normal">(optional)</span>
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Billing questions that should reach the billing team."
              className="h-7 text-[12px]"
            />
          </div>
          {create.isError && (
            <p className="text-[11px] text-destructive">
              {(create.error as Error)?.message ?? "Failed to create dataset"}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            disabled={!name.trim() || create.isPending}
            onClick={submit}
          >
            Create dataset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
