"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { cn } from "@/lib/utils";

/** What /loops shows for a project with no loop: one line and the way to create one. */
export function LoopsEmpty({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3">
      <DOMAIN_ICONS.loop className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
      <p className="text-[13px] text-muted-foreground">No loops yet</p>
      <p className="text-[12px] text-muted-foreground">
        Create a loop to review your traces on a schedule.
      </p>
      <Link
        href={`/projects/${projectId}/loops/new`}
        className={cn(buttonVariants({ size: "sm" }), "mt-1 h-7 text-[12px]")}
      >
        New loop
      </Link>
    </div>
  );
}
