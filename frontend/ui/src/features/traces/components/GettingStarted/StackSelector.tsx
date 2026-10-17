"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { IntegrationPickerCard } from "./IntegrationPickerCard";
import {
  filterIntegrations,
  INTEGRATION_GROUPS,
  type IntegrationFilter,
  type IntegrationOption,
} from "./integrations";

/** "All" first, then the catalogue's own groups in its own order. */
const TABS: { value: IntegrationFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...INTEGRATION_GROUPS.map((group) => ({ value: group.category, label: group.label })),
];

interface StackSelectorProps {
  selected: IntegrationOption;
  onSelect: (integrationId: string) => void;
}

/**
 * The one question the rest of the panel is an answer to.
 *
 * Twenty entries is past the point where a flat wall of logos can be read, and
 * the two groups it used to be split into did not help: "Frameworks" held both
 * the agent frameworks somebody arrives looking for by name and the SDKs they
 * would never think to look for under that word. Three groups and a search are
 * two different ways in — browse if you know the shape of what you have, type
 * if you know its name — and either way the answer feeds the install command,
 * the snippet, the docs link and the key field below.
 *
 * Filtering never changes the selection. Someone who picks CrewAI and then
 * types "mastra" to see whether it is supported has not chosen Mastra, and
 * moving the snippet out from under them for a search they are reading would
 * be a surprising way to find out. So the cards narrow, the selection holds,
 * and the selected card is simply not among the ones on screen for a moment.
 */
export function StackSelector({ selected, onSelect }: StackSelectorProps) {
  const [tab, setTab] = useState<IntegrationFilter>("all");
  const [query, setQuery] = useState("");

  const matches = filterIntegrations(query, tab);
  // Group headings earn their place only in "All", where they are the thing
  // telling two adjacent rows of logos apart. Under a single group tab the
  // heading would just repeat the tab the reader has already pressed.
  const groups =
    tab === "all"
      ? INTEGRATION_GROUPS.map((group) => ({
          label: group.label,
          items: matches.filter((integration) => integration.category === group.category),
        })).filter((group) => group.items.length > 0)
      : [{ label: null, items: matches }];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground">Select your stack</p>
        <a
          href="https://github.com/traceroot-ai/traceroot/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Don&apos;t see yours? Request one
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search integrations"
            placeholder="Search integrations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 pl-8 text-[12px]"
          />
        </div>

        <div role="tablist" aria-label="Integration groups" className="flex flex-wrap gap-1">
          {TABS.map((candidate) => (
            <button
              key={candidate.value}
              type="button"
              role="tab"
              aria-selected={tab === candidate.value}
              onClick={() => setTab(candidate.value)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
                tab === candidate.value
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground hover:border-primary hover:text-foreground",
              )}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </div>

      {matches.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          Nothing in this list matches that. Clear the search, or{" "}
          <a
            href="https://github.com/traceroot-ai/traceroot/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-4"
          >
            request the integration
          </a>
          .
        </p>
      ) : (
        <div role="radiogroup" aria-label="Stack" className="space-y-3">
          {groups.map((group, index) => (
            <div key={group.label ?? index} className="space-y-1.5">
              {group.label && (
                <p className="text-[12px] font-medium text-muted-foreground">{group.label}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {group.items.map((integration) => (
                  <IntegrationPickerCard
                    key={integration.id}
                    integration={integration}
                    selected={selected.id === integration.id}
                    onSelect={() => onSelect(integration.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
