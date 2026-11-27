"use client";

import Link from "next/link";
import { useEffect } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ApiError, ImpersonationError } from "@/lib/api/errors";
import { getProjectFirstTraceTime } from "@/lib/api/projects";
import { ACTIVITY_REFRESH_INTERVAL_MS } from "@/features/workspaces/hooks";
import { forgetSetup, useSetupResume } from "../setup-resume";
import { setupStepUrl } from "../step-urls";

export function ResumeSetupLink({ userId }: { userId: string }) {
  const resume = useSetupResume(userId);
  const projectId = resume?.projectId;
  // A stored ID identifies the last setup, not whether this account can still
  // access it or whether another teammate has since sent the first trace.
  const status = useQuery({
    queryKey: ["resume-setup", userId, projectId],
    queryFn: projectId ? () => getProjectFirstTraceTime(projectId) : skipToken,
    gcTime: 0,
    retry: false,
    refetchInterval: ({ state: { data, error } }) => {
      if (error instanceof ApiError && !(error instanceof ImpersonationError) && error.status < 500)
        return false;
      return data === null || error ? ACTIVITY_REFRESH_INTERVAL_MS : false;
    },
  });
  const firstTrace = status.data;
  const denied =
    status.error instanceof ApiError &&
    !(status.error instanceof ImpersonationError) &&
    [403, 404].includes(status.error.status);
  useEffect(() => {
    if (projectId && (firstTrace || denied)) {
      forgetSetup(userId, projectId);
    }
  }, [userId, projectId, firstTrace, denied]);

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
