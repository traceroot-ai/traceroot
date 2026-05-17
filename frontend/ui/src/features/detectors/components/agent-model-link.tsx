"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getAvailableLLMModels } from "@/lib/api";
import {
  flattenAvailableModels,
  pickDefaultModel,
} from "@/features/ai-assistant/lib/resolve-model";

interface AgentModelLinkProps {
  projectId: string;
  rcaModel?: string | null;
  workspaceId?: string;
}

export function AgentModelLink({ projectId, rcaModel, workspaceId }: AgentModelLinkProps) {
  const { data } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: !!workspaceId,
  });

  const models = flattenAvailableModels(data);

  const resolvedLabel = (() => {
    if (rcaModel) {
      const match = models.find((m) => m.id === rcaModel);
      return match?.label ?? rcaModel;
    }
    const pick = pickDefaultModel(models);
    return pick?.label ?? pick?.id ?? "Default";
  })();

  return (
    <Link
      href={`/projects/${projectId}/settings/detectors`}
      className="inline-flex h-7 items-center gap-1 rounded-sm px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {resolvedLabel}
      <ExternalLink className="h-3 w-3" />
    </Link>
  );
}
