import Link from "next/link";
import { cn } from "@/lib/utils";
import { serializeFiltersParam } from "@/features/filters/predicate";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";

/** The Tracing list narrowed to the traces of one group. */
export function topicTracesHref(projectId: string, groupId: string): string {
  const params = new URLSearchParams({
    filters: serializeFiltersParam([{ field: "group_id", op: "eq", value: groupId }])!,
  });
  return `/projects/${projectId}/traces?${params.toString()}`;
}

/** A trace's group as a small chip; a link to that group's traces when `projectId` is given. */
export function TopicBadge({
  name,
  groupId,
  projectId,
  className,
}: {
  name: string;
  groupId: string;
  projectId?: string;
  className?: string;
}) {
  const chip = cn(
    "inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-foreground",
    className,
  );
  const content = (
    <>
      <DOMAIN_ICONS.topic className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </>
  );
  if (!projectId) {
    return (
      <span className={chip} title={name}>
        {content}
      </span>
    );
  }
  return (
    <Link
      href={topicTracesHref(projectId, groupId)}
      // The row opens the trace; the chip opens the group's traces instead.
      onClick={(e) => e.stopPropagation()}
      title={`${name} — show this topic's traces`}
      className={cn(chip, "transition-colors hover:bg-muted")}
    >
      {content}
    </Link>
  );
}
