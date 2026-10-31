"use client";

import { Loader2 } from "lucide-react";
import { ExpandableSection } from "@/components/ui/expandable-section";
import { ContentRenderer } from "./ContentRenderer";
import { AttachmentSourceContext, type AttachmentSource } from "./inline-media";

/**
 * A collapsible span I/O / metadata section: a title, an optional copy button, and
 * the value rendered by ContentRenderer (the smart JSON tree / media renderer).
 * This matches the production trace-detail chrome — a plain expandable section with
 * no format switcher. ContentRenderer already truncates and collapses large payloads.
 */
export function TraceIOSection({
  title,
  content,
  onCopy,
  loading = false,
  defaultOpen = true,
  attachmentSource = null,
}: {
  title: string;
  content: string | null;
  onCopy?: () => void;
  loading?: boolean;
  defaultOpen?: boolean;
  /** The span the content belongs to, so image references in it can load. */
  attachmentSource?: AttachmentSource | null;
}) {
  return (
    <ExpandableSection title={title} defaultOpen={defaultOpen} onCopy={onCopy}>
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading…
        </div>
      ) : (
        <AttachmentSourceContext.Provider value={attachmentSource}>
          <ContentRenderer content={content} />
        </AttachmentSourceContext.Provider>
      )}
    </ExpandableSection>
  );
}
