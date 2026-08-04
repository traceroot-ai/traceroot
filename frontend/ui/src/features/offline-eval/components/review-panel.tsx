"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { ValueBlock } from "./code";
import { HUMAN_VERDICT_LABEL, type HumanReview, type HumanVerdict } from "../types";

/** JSON I/O is shown structured (so ValueBlock's format toggle works); plain text stays
 *  a string. Mirrors how the save-as-test-case drawer presents the same fields. */
function parsedValue(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Human review — the essential human-scoring step, and the one thing a person
 * creates in the UI. The same panel opens from a production span and from an
 * evaluation result, so reviewing feels like one activity.
 *
 * It scores one observed output and nothing else. Changing what future runs are
 * compared against is a separate, confirmed action ("Update expected outcome"),
 * so human-scoring can never silently mutate the source dataset.
 */

export interface ReviewTarget {
  /**
   * Stable identity for this target (e.g. the result/span id), independent of
   * object identity. Callers build `target` as a fresh object literal on every
   * render, so the form-seeding effect below keys on this instead of on `target`
   * itself — otherwise any parent re-render (a background refetch, a mutation
   * settling) would look like "the user opened a new target" and wipe an
   * in-progress, unsaved review.
   */
  targetKey: string;
  /** Where the review was opened from. */
  contextLabel: string;
  input: string;
  output: string;
  expected: string | null;
  /** Existing automatic scores, shown alongside the human decision. */
  autoScores: Array<{ name: string; display: string; explanation?: string }>;
  existing?: HumanReview;
  /** Optional trace/span evidence rendered by the caller. */
  evidence?: React.ReactNode;
}

export function ReviewPanel({
  target,
  open,
  onOpenChange,
  onSave,
  savedDescription,
  footerNote = "Recorded on this run.",
}: {
  target: ReviewTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * May reject/throw to report a save failure. Awaited by `handleSave`, which
   * only toasts success and closes the drawer once this resolves — a failure
   * keeps the drawer open with the reviewer's input intact and toasts an error
   * instead, since a false "saved" here is silent data loss.
   */
  onSave: (review: HumanReview) => void | Promise<unknown>;
  /** Toast description shown after saving; omit for none. */
  savedDescription?: string;
  /** Small note in the footer (e.g. "Saved in this page only."). */
  footerNote?: string;
}) {
  const { toast } = useToast();

  const [verdict, setVerdict] = React.useState<HumanVerdict>("pass");
  const [quality, setQuality] = React.useState<number | undefined>(undefined);
  const [comment, setComment] = React.useState("");
  const [showEvidence, setShowEvidence] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open || !target) return;
    const existing = target.existing;
    setVerdict(existing?.verdict ?? "pass");
    setQuality(existing?.quality);
    setComment(existing?.comment ?? "");
    setShowEvidence(false);
    // Keyed on the stable targetKey, not on `target` itself — callers pass a fresh
    // object literal every render, and depending on that identity would reset the
    // form (discarding an unsaved review) on any unrelated parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.targetKey]);

  if (!target) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        verdict,
        quality,
        comment: comment.trim() || undefined,
        reviewer: "You",
        at: new Date().toISOString(),
      });
      toast({
        title: "Review saved",
        ...(savedDescription ? { description: savedDescription } : {}),
        tone: "success",
      });
      onOpenChange(false);
    } catch (e) {
      // Keep the drawer open with the reviewer's input intact — closing here
      // (or toasting success) would discard a review that was never persisted.
      toast({ title: "Could not save the review", description: String(e), tone: "warning" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width="w-[560px]">
        <DrawerHeader className="pr-10">
          <DrawerTitle>Review</DrawerTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">{target.contextLabel}</p>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-4 text-[12px]">
          <ValueBlock label="Input" value={parsedValue(target.input)} />
          <ValueBlock label="Output" value={parsedValue(target.output)} />
          {target.expected ? (
            <ValueBlock label="Expected" value={parsedValue(target.expected)} />
          ) : (
            <Block label="Expected">
              <p className="text-muted-foreground">
                Not required — a scorer judges the output directly.
              </p>
            </Block>
          )}

          {target.autoScores.length > 0 && (
            <Block label="Automatic scores">
              <ul className="flex flex-col gap-1.5">
                {target.autoScores.map((score) => (
                  <li key={score.name}>
                    <span className="text-foreground">{score.name}: </span>
                    <span className="text-muted-foreground">{score.display}</span>
                    {score.explanation && (
                      <p className="mt-0.5 leading-relaxed text-muted-foreground">
                        {score.explanation}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {target.evidence && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-0 text-[12px] text-muted-foreground hover:bg-transparent hover:text-foreground"
                onClick={() => setShowEvidence((current) => !current)}
                aria-expanded={showEvidence}
              >
                {showEvidence ? "Hide the trace" : "Show the trace"}
              </Button>
              {showEvidence && <div className="mt-2">{target.evidence}</div>}
            </div>
          )}

          <div className="h-px bg-border" />

          <div>
            <p className="mb-1.5 font-medium">Was this right?</p>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Decision">
              {(Object.keys(HUMAN_VERDICT_LABEL) as HumanVerdict[]).map((option) => (
                <Button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={verdict === option}
                  variant={verdict === option ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-[12px]"
                  onClick={() => setVerdict(option)}
                >
                  {HUMAN_VERDICT_LABEL[option]}
                </Button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              This judges what happened this time. It does not change what future runs are compared
              against.
            </p>
          </div>

          <div>
            <p className="mb-1.5 font-medium">
              Quality <span className="font-normal text-muted-foreground">optional</span>
            </p>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Quality score">
              {[1, 2, 3, 4, 5].map((value) => (
                <Button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={quality === value}
                  variant={quality === value ? "default" : "outline"}
                  size="sm"
                  className="h-7 w-7 p-0 text-[12px] tabular-nums"
                  onClick={() => setQuality(quality === value ? undefined : value)}
                >
                  {value}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="review-comment" className="mb-1.5 block font-medium">
              Comment <span className="font-normal text-muted-foreground">optional</span>
            </label>
            <Input
              id="review-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Why did you decide this?"
              className="h-7 text-[12px]"
            />
          </div>
        </DrawerBody>

        <DrawerFooter>
          <span className="text-[11px] text-muted-foreground">{footerNote}</span>
          <span className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button size="sm" className="h-7 text-[12px]" disabled={saving} onClick={handleSave}>
              {saving ? "Saving..." : "Save review"}
            </Button>
          </span>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] text-muted-foreground">{label}</p>
      <div className={cn("rounded border border-border bg-muted/20 px-2.5 py-2")}>{children}</div>
    </div>
  );
}
