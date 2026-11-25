import type { LucideIcon } from "lucide-react";
import { Database, FlaskConical, House } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import type { MessageKey } from "@/lib/i18n/messages/en";

export interface NavItem {
  key: string;
  label: string;
  /** The label's translation key. `label` stays as the English text for code that needs a name. */
  labelKey: MessageKey;
  /** Path segment under /projects/:projectId/. */
  segment: string;
  icon: LucideIcon;
  /** Extra first segments that keep this item active (Tracing owns its sibling tabs). */
  alsoActiveOn?: string[];
}

export interface NavGroup {
  label: string;
  labelKey: MessageKey;
  items: NavItem[];
}

export const NAV_HOME: NavItem = {
  key: "home",
  label: "Home",
  labelKey: "nav.home",
  segment: "home",
  icon: House,
};

/** The product loop: see what the agent did, find what went wrong, verify the fix. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Observe",
    labelKey: "nav.observe",
    items: [
      {
        key: "traces",
        label: "Tracing",
        labelKey: "nav.traces",
        segment: "traces",
        icon: DOMAIN_ICONS.trace,
        alsoActiveOn: ["users", "sessions"],
      },
      {
        key: "dashboard",
        label: "Dashboard",
        labelKey: "nav.dashboard",
        segment: "dashboard",
        icon: DOMAIN_ICONS.dashboard,
      },
    ],
  },
  {
    label: "Detect",
    labelKey: "nav.detect",
    items: [
      {
        key: "detectors",
        label: "Detectors",
        labelKey: "nav.detectors",
        segment: "detectors",
        icon: DOMAIN_ICONS.detector,
      },
      {
        key: "signals",
        label: "Signals",
        labelKey: "nav.signals",
        segment: "signals",
        icon: DOMAIN_ICONS.signal,
      },
      {
        key: "alerts",
        label: "Alerts",
        labelKey: "nav.alerts",
        segment: "alerts",
        icon: DOMAIN_ICONS.alert,
      },
    ],
  },
  {
    label: "Verify",
    labelKey: "nav.verify",
    items: [
      {
        key: "datasets",
        label: "Datasets",
        labelKey: "nav.datasets",
        segment: "datasets",
        icon: Database,
      },
      {
        key: "evaluations",
        label: "Evaluations",
        labelKey: "nav.evaluations",
        segment: "evaluations",
        icon: FlaskConical,
      },
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
