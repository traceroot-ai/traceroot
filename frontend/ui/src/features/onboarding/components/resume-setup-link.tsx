"use client";

import Link from "next/link";
import { useEffect } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { getProjectFirstTraceTime } from "@/lib/api/projects";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { ACTIVITY_REFRESH_INTERVAL_MS } from "@/features/workspaces/hooks";
import { forgetSetup, setupResumeKey, type SetupResume } from "../setup-resume";
import { setupStepUrl } from "../step-urls";

export function ResumeSetupLink({ userId }: { userId: string }) {
  const [resume] = useLocalStorage<SetupResume | null>(setupResumeKey(userId), null);
  const projectId = resume?.projectId;
  // A stored ID identifies the last setup, not whether this account can still
  // access it or whether another teammate has since sent the first trace.
  const status = useQuery({
    queryKey: ["resume-setup", userId, projectId],
    queryFn: projectId ? () => getProjectFirstTraceTime(projectId) : skipToken,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.data === null ? ACTIVITY_REFRESH_INTERVAL_MS : false),
  });
  const firstTrace = status.data;
  useEffect(() => {
    if (projectId && firstTrace) forgetSetup(userId, projectId);
  }, [userId, projectId, firstTrace]);

  if (!resume || !status.isSuccess || firstTrace !== null) return null;
  return (
    <Link
      href={setupStepUrl(resume.projectId, resume.created)}
      className="text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
    >
      Resume setup
    </Link>
  );
}
