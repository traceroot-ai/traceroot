"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchTraceApi } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import {
  normalizeTriggerConditions,
  validateTriggerConditions,
  type TriggerCondition,
} from "../trigger-fields";

interface FilterPreviewResponse {
  trace_id: string;
  matches: boolean;
  condition_matches: boolean[];
}

interface FilterPreviewProps {
  projectId: string;
  conditions: TriggerCondition[];
  disabled?: boolean;
}

export function FilterPreview({ projectId, conditions, disabled = false }: FilterPreviewProps) {
  const [traceId, setTraceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    data?: FilterPreviewResponse;
    error?: string;
  } | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  const normalized = normalizeTriggerConditions(conditions);
  const validationError = validateTriggerConditions(normalized);
  const trimmedTraceId = traceId.trim();
  const key = JSON.stringify([projectId, trimmedTraceId, normalized]);
  const visible = !disabled && result?.key === key ? result : null;

  const runPreview = async () => {
    if (disabled || !trimmedTraceId || validationError) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setResult(null);
    try {
      const data = await fetchTraceApi<FilterPreviewResponse>(
        `/projects/${encodeURIComponent(projectId)}/detectors/preview`,
        {
          method: "POST",
          body: JSON.stringify({ trace_id: trimmedTraceId, conditions: normalized }),
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted) setResult({ key, data });
    } catch (error) {
      if (!controller.signal.aborted) {
        const message =
          error instanceof ApiError && error.status === 404
            ? "Trace not found in this project."
            : error instanceof ApiError && error.status === 403
              ? "This trace is outside your retention window or you cannot access it."
              : "Could not preview this trace. Please try again.";
        setResult({
          key,
          error: message,
        });
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <div className="border border-border p-3">
      <div className="text-[13px] font-medium text-foreground">Preview filter on a trace</div>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Test these draft conditions on a trace ID from this project. This reads the trace only; it
        does not save the detector, apply sampling, or run a model. A live trace may change as more
        spans arrive.
      </p>
      <div className="mt-3 flex gap-2">
        <Input
          aria-label="Trace ID to preview"
          value={traceId}
          onChange={(event) => setTraceId(event.target.value)}
          disabled={disabled}
          placeholder="Paste a trace ID"
          className="h-8 min-w-0 font-mono text-[12px]"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !trimmedTraceId || !!validationError || busy}
          onClick={() => void runPreview()}
          className="h-8 shrink-0 text-[12px]"
        >
          {busy ? "Checking…" : "Preview"}
        </Button>
      </div>
      {validationError && (
        <p className="mt-2 text-[12px] text-destructive">Complete the filter before previewing.</p>
      )}
      {visible?.error && (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {visible.error}
        </p>
      )}
      {visible?.data && (
        <div role="status" className="mt-3 text-[12px]">
          <p className="font-medium">
            {visible.data.matches
              ? "Filter matches this trace"
              : "Filter does not match this trace"}
          </p>
          {visible.data.condition_matches.length === 0 ? (
            <p className="mt-1 text-muted-foreground">
              No conditions: every trace matches the filter.
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {visible.data.condition_matches.map((matched, index) => (
                <li key={index}>
                  Condition {index + 1}: {matched ? "matches" : "does not match"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
