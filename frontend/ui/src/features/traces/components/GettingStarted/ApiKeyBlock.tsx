"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { createAccessKey } from "@/lib/api";

interface ApiKeyBlockProps {
  projectId: string;
}

export function ApiKeyBlock({ projectId }: ApiKeyBlockProps) {
  const queryClient = useQueryClient();
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => createAccessKey(projectId),
    onMutate: () => {
      setError(null);
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["access-keys", projectId] });
      setGeneratedKey(response.data.key);
    },
    onError: () => {
      setError("Failed to generate key. Please try again.");
    },
  });

  if (generatedKey) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 border border-border bg-muted px-3 py-2 font-mono text-xs">
          <span className="text-muted-foreground">TRACEROOT_API_KEY=</span>
          <span className="flex-1 truncate text-foreground">&quot;{generatedKey}&quot;</span>
          <CopyButton value={`TRACEROOT_API_KEY="${generatedKey}"`} className="h-6 w-6 shrink-0" />
        </div>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="h-3 w-3 text-green-600" />
          Copy this key — you won&apos;t see it again.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <div className="flex flex-1 items-center border border-border bg-muted px-3 py-2 font-mono text-xs">
          <span className="text-muted-foreground">TRACEROOT_API_KEY=</span>
          <span className="text-muted-foreground/50">&quot;your_key_here&quot;</span>
        </div>
        <Button
          size="sm"
          className="h-9 shrink-0 px-4 text-xs"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? "Generating..." : "Generate"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
