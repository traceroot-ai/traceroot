"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createSampleTrace } from "@/lib/api";

interface SampleTraceButtonProps {
  projectId: string;
}

export function SampleTraceButton({ projectId }: SampleTraceButtonProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => createSampleTrace(projectId),
    onSuccess: async (trace) => {
      await queryClient.invalidateQueries({ queryKey: ["traces", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["trace", projectId, trace.trace_id] });
      router.push(`/projects/${projectId}/traces?traceId=${trace.trace_id}&fullscreen=1`);
    },
  });

  return (
    <div className="rounded-sm border border-border bg-muted/30 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Want to see TraceRoot first?</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create a sample agent trace without configuring an app or LLM provider.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 text-xs"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Creating..." : "Create sample trace"}
        </Button>
      </div>
      {mutation.isError && (
        <p className="mt-2 text-xs text-destructive">
          Couldn&apos;t create the sample trace. Please try again.
        </p>
      )}
    </div>
  );
}
