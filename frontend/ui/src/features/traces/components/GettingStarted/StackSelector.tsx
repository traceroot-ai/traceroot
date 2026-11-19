"use client";

import { IntegrationPickerCard } from "./IntegrationPickerCard";
import { SectionLink } from "./SectionLink";
import { INTEGRATIONS, INTEGRATION_GROUPS, type IntegrationOption } from "./integrations";

/** Every entry, under its group heading, with empty groups left out. */
const GROUPS = INTEGRATION_GROUPS.map((group) => ({
  label: group.label,
  items: INTEGRATIONS.filter((integration) => integration.category === group.category),
})).filter((group) => group.items.length > 0);

interface StackSelectorProps {
  selected: IntegrationOption;
  onSelect: (integrationId: string) => void;
}

/**
 * The one question the rest of the panel is an answer to.
 *
 * Every entry, on screen, under two headings. There was briefly a search box
 * and a row of group tabs above the cards, and both were machinery for a
 * problem a list this size does not have: twenty cards fit, and a reader who
 * can see all twenty has nothing to search for and nothing to filter. What the
 * tabs did instead was hide most of the list behind a press, and split the
 * frameworks from the SDKs on a distinction that is real in the code and not in
 * anybody's head — which put the Claude Agent SDK two clicks away from CrewAI.
 *
 * The provider/framework heading stays, because that split is the one the
 * reader can act on: it is the difference between a key field with one right
 * answer and a key field with a dropdown.
 *
 * The answer feeds the key field below and the manual walkthrough's install
 * command, snippet and docs link. The setup command does not take it: its
 * single `traceroot setup` line detects the stack in the repository it is run
 * in, and its docs link is the general tracing guide.
 */
export function StackSelector({ selected, onSelect }: StackSelectorProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground">Select your stack</p>
        <SectionLink href="https://github.com/traceroot-ai/traceroot/issues/new">
          Don&apos;t see yours? Request one
        </SectionLink>
      </div>

      <div role="radiogroup" aria-label="Stack" className="space-y-3">
        {GROUPS.map((group) => (
          <div key={group.label} className="space-y-1.5">
            <p className="text-[12px] font-medium text-muted-foreground">{group.label}</p>
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
    </div>
  );
}
