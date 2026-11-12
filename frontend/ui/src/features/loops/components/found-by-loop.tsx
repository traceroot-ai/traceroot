"use client";

import Link from "next/link";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { useLoopsByDetector } from "../hooks/use-loops";

/** The Loop that owns a detector id (a Loop's hidden detector), or null. */
export function useFoundByLoop(projectId: string, detectorId: string) {
  const { data } = useLoopsByDetector(projectId);
  return data?.get(detectorId) ?? null;
}

/** "Found by Loop <name>", linking to the Loop; renders nothing when the signal is a detector's. */
export function FoundByLoop({
  projectId,
  detectorId,
  className,
  onClick,
}: {
  projectId: string;
  detectorId: string;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const loop = useFoundByLoop(projectId, detectorId);
  if (!loop) return null;
  return (
    <Link
      href={`/projects/${projectId}/loops/${loop.id}`}
      onClick={onClick}
      className={className ?? "inline-flex items-center gap-1 hover:underline"}
    >
      <DOMAIN_ICONS.loop className="h-3 w-3 shrink-0" aria-hidden="true" />
      Found by Loop {loop.name}
    </Link>
  );
}
