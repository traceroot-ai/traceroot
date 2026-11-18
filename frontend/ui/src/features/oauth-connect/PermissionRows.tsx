import { Database, Lock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";

// What the mcp:read scope lets an assistant do, as the consent screen lists it.
// Everything is read access to the one project chosen.
const PERMISSIONS: { icon: LucideIcon; title: string; detail: string }[] = [
  {
    icon: DOMAIN_ICONS.trace,
    title: "Traces and sessions",
    detail: "Spans with their inputs, outputs, timing and cost",
  },
  {
    icon: DOMAIN_ICONS.detector,
    title: "Findings, detectors and alerts",
    detail: "Issues TraceRoot found and the rules that watch for them",
  },
  {
    icon: DOMAIN_ICONS.dashboard,
    title: "Dashboards and datasets",
    detail: "Saved charts and the datasets behind evaluations",
  },
  {
    icon: Database,
    title: "Queries",
    detail: "Read-only SQL over this project's data",
  },
];

export function PermissionRows() {
  return (
    <div>
      <ul className="divide-y rounded-md border" aria-label="Permissions">
        {PERMISSIONS.map(({ icon: Icon, title, detail }) => (
          <li key={title} className="flex items-center gap-3 px-3 py-2.5">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-tight">{title}</p>
              <p className="mt-0.5 text-[12px] leading-tight text-muted-foreground">{detail}</p>
            </div>
            <Badge variant="outline">Read</Badge>
          </li>
        ))}
      </ul>
      <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Lock className="h-3 w-3" aria-hidden />
        Can&apos;t change anything · can&apos;t see other projects
      </p>
    </div>
  );
}
