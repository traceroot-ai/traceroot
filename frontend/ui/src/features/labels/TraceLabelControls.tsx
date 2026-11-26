"use client";

import { useState } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { setTraceLabel } from "./api";
import {
  traceLabelsKey,
  useCanManageProjectLabels,
  useProjectLabels,
  useTraceLabels,
} from "./queries";

interface TraceLabelTarget {
  projectId: string;
  traceId: string;
  spanId: string | null;
}

export function TraceLabelChips({ projectId, traceId, spanId }: TraceLabelTarget) {
  const { data, isError } = useTraceLabels(projectId, traceId, spanId, true);

  if (isError) {
    return <p className="mt-2 text-xs text-muted-foreground">Could not load labels.</p>;
  }
  if (!data?.values.length) return null;

  return (
    <div role="group" aria-label="Labels" className="mt-2 flex flex-wrap gap-2">
      {data.values.map((value) => (
        <Badge
          key={value}
          variant="outline"
          className="min-w-0 max-w-full gap-1.5 rounded-md bg-background px-2.5 py-1 text-xs leading-4 text-foreground"
        >
          <DOMAIN_ICONS.label className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate" title={value}>
            {value}
          </span>
        </Badge>
      ))}
    </div>
  );
}

export function TraceLabelPicker({ projectId, traceId, spanId }: TraceLabelTarget) {
  const canManage = useCanManageProjectLabels(projectId);
  const { data: target } = useTraceLabels(projectId, traceId, spanId, canManage);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: labels, isPending, isError } = useProjectLabels(projectId, open && canManage);
  const queryClient = useQueryClient();
  const queryKey = traceLabelsKey(projectId, traceId, spanId);
  const mutationKey = ["set-trace-label", ...queryKey] as const;

  const mutation = useMutation({
    mutationKey,
    mutationFn: ({ value, checked }: { value: string; checked: boolean }) =>
      setTraceLabel(projectId, traceId, spanId, value, checked),
    onMutate: () => queryClient.cancelQueries({ queryKey, exact: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      // An active label filter can gain or lose the parent trace as assignments change.
      void queryClient.invalidateQueries({ queryKey: ["traces", projectId] });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey, exact: true }),
  });
  const saving = useIsMutating({ mutationKey, exact: true }) > 0;

  if (!canManage || !target) return null;

  const term = search.trim().toLowerCase();
  const options = labels?.filter(({ name }) => name.toLowerCase().includes(term));

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setSearch("");
          mutation.reset();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 text-[12px]">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add label
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Add label" align="end" className="z-[60] w-60 space-y-1 p-2">
        <Input
          aria-label="Search labels"
          placeholder="Search labels…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {isPending ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">Loading labels…</p>
        ) : isError ? (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            Could not load project labels.
          </p>
        ) : !options?.length ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {term ? "No matching labels." : "No project labels yet."}
          </p>
        ) : (
          <div className="max-h-44 overflow-y-auto" aria-busy={saving}>
            {options.map(({ id, name }) => (
              <label
                key={id}
                className="flex min-h-7 cursor-pointer items-center gap-2 rounded-[2px] px-2 py-1 text-[13px] hover:bg-muted"
              >
                <Checkbox
                  checked={target.appliedByMe.includes(name)}
                  disabled={saving}
                  onCheckedChange={(checked) => {
                    if (!queryClient.isMutating({ mutationKey, exact: true })) {
                      mutation.mutate({ value: name, checked });
                    }
                  }}
                />
                <span className="min-w-0 break-words">{name}</span>
              </label>
            ))}
          </div>
        )}
        {mutation.isError && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {mutation.error.message}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
