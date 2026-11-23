import * as React from "react";
import type { TraceViewerPanel } from "@/features/traces/components/TraceViewerPanel";

type Props = React.ComponentProps<typeof TraceViewerPanel>;

/**
 * The trace panel, for tests of the comparison that only open a case in it: its header
 * (the host's item, previous/next, close) and what it shows at the root in diff mode, the
 * host's case. The trace panel's own tests mount the real panel.
 */
export function ViewerStandIn(props: Props) {
  const noun = props.headerItem?.noun ?? "trace";
  return (
    <div>
      {props.headerItem?.title}
      <button
        type="button"
        title={`Previous ${noun}`}
        disabled={!props.canNavigateUp}
        onClick={() => props.onNavigate("up")}
      />
      <button
        type="button"
        title={`Next ${noun}`}
        disabled={!props.canNavigateDown}
        onClick={() => props.onNavigate("down")}
      />
      <button type="button" title="Close" onClick={props.onClose} />
      {props.diffToolbar}
      {props.notice ?? (
        <>
          {props.diffBaseline?.root?.tags}
          {props.spanHeaderAction?.({ type: "trace" })}
          {props.diffBaseline?.root?.body}
        </>
      )}
    </div>
  );
}
