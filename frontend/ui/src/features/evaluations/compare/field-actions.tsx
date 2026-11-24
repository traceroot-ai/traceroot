"use client";

import * as React from "react";
import { PanelRightOpen } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { IconButton } from "@/components/ui/icon-button";

const BUTTON = "h-5 w-5 text-muted-foreground hover:text-foreground";

/**
 * A text value's own controls, over the end of its first line: Copy, which copies its
 * full text as recorded, and Open in trace panel. They sit in the nearest `group/field`
 * (relative), outside any clipped text so neither they nor their focus rings are cut off,
 * and show while it is hovered or holds focus. They are mounted only while their case's
 * group is hovered or holds focus (see `CaseGroup`): Tab from a group reaches its own
 * controls, but Shift+Tab from the group below doesn't reach them. Their backing takes the
 * group's fill (the group is `group/row`): plain, hovered or open. Being buttons, a click
 * or key on one never opens the case as well (see `clickOpensRow`). A value with no text
 * has none.
 */
export function FieldActions({
  text,
  name,
  onOpen,
}: {
  text: string | null;
  /** What the value is, for the buttons' names: "input", "#2 output". */
  name: string;
  onOpen: () => void;
}) {
  if (!text?.trim()) return null;
  return (
    <span className="absolute right-0 top-0 flex items-center gap-0.5 rounded-[2px] bg-background opacity-0 transition-opacity group-focus-within/field:opacity-100 group-hover/row:bg-muted group-hover/field:opacity-100 group-data-[selected=true]/row:bg-accent">
      <CopyButton
        value={text}
        aria-label={`Copy ${name}`}
        title="Copy"
        className={BUTTON}
        iconClassName="h-3 w-3"
      />
      <IconButton
        icon={<PanelRightOpen className="h-3 w-3" />}
        aria-label={`Open ${name} in the trace panel`}
        title="Open in trace panel"
        onClick={onOpen}
        className={BUTTON}
      />
    </span>
  );
}
