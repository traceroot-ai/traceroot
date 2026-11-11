import type { LucideIcon } from "lucide-react";
import { Database, FlaskConical, House } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";

export interface NavItem {
  key: string;
  label: string;
  /** Path segment under /projects/:projectId/. */
  segment: string;
  icon: LucideIcon;
  /** Extra first segments that keep this item active (Tracing owns its sibling tabs). */
  alsoActiveOn?: string[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_HOME: NavItem = { key: "home", label: "Home", segment: "home", icon: House };

/** The product loop: see what the agent did, find what went wrong, verify the fix. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Observe",
    items: [
      {
        key: "traces",
        label: "Tracing",
        segment: "traces",
        icon: DOMAIN_ICONS.trace,
        alsoActiveOn: ["users", "sessions"],
      },
      { key: "dashboard", label: "Dashboard", segment: "dashboard", icon: DOMAIN_ICONS.dashboard },
    ],
  },
  {
    label: "Detect",
    items: [
      { key: "detectors", label: "Detectors", segment: "detectors", icon: DOMAIN_ICONS.detector },
      { key: "signals", label: "Signals", segment: "signals", icon: DOMAIN_ICONS.signal },
      { key: "alerts", label: "Alerts", segment: "alerts", icon: DOMAIN_ICONS.alert },
    ],
  },
  {
    label: "Verify",
    items: [
      { key: "datasets", label: "Datasets", segment: "datasets", icon: Database },
      { key: "evaluations", label: "Evaluations", segment: "evaluations", icon: FlaskConical },
    ],
  },
];

export function navHref(projectId: string, item: NavItem): string {
  return `/projects/${projectId}/${item.segment}`;
}

export function isNavItemActive(pathname: string, projectId: string, item: NavItem): boolean {
  return [item.segment, ...(item.alsoActiveOn ?? [])].some((segment) => {
    const base = `/projects/${projectId}/${segment}`;
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}
