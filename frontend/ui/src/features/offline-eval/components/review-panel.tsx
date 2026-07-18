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
import { HUMAN_VERDICT_LABEL, type HumanReview, type HumanVerdict } from "../types";

/**
 * Human review — the essential human-scoring step, and the one thing a person
 * creates in the UI. The same panel opens from a production span and from an
 * evaluation result, so reviewing feels like one activity.
 *
 * It keeps two decisions apart on purpose: a verdict judges what happened this
 * once; a corrected expected output changes what future runs are compared
 * against.
 */

export interface ReviewTarget {
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
}: {
  target: ReviewTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (review: HumanReview) => void;
}) {
  const { toast } = useToast();

  const [verdict, setVerdict] = React.useState<HumanVerdict>("pass");
  const [quality, setQuality] = React.useState<number | undefined>(undefined);
  const [corrected, setCorrected] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [showEvidence, setShowEvidence] = React.useState(false);

  React.useEffect(() => {
    if (!open || !target) return;
    const existing = target.existing;
    setVerdict(existing?.verdict ?? "pass");
    setQuality(existing?.quality);
    setCorrected(existing?.correctedExpected ?? "");
    setComment(existing?.comment ?? "");
    setShowEvidence(false);
  }, [open, target]);

  if (!target) return null;

  const expectedChanged = corrected.trim() !== "" && corrected.trim() !== (target.expected ?? "");

  const handleSave = () => {
    onSave({
      verdict,
      quality,
      correctedExpected: expectedChanged ? corrected.trim() : undefined,
      comment: comment.trim() || undefined,
      reviewer: "You",
      at: new Date().toISOString(),
    });
    toast({
      title: "Review saved",
      description: expectedChanged
        ? "Your decision and the corrected expected output were recorded. Prototype only."
        : "Your decision was recorded. Prototype only.",
      tone: "success",
    });
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width="w-[560px]">
        <DrawerHeader className="pr-10">
          <DrawerTitle>Review</DrawerTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">{target.contextLabel}</p>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-4 text-[12px]">
          <Block label="What was asked">
            <p className="leading-relaxed">{target.input}</p>
          </Block>
          <Block label="What the app produced">
            <p className="leading-relaxed">{target.output}</p>
          </Block>
          <Block label="Expected output">
            {target.expected ? (
              <p className="leading-relaxed">{target.expected}</p>
            ) : (
              <p className="text-muted-foreground">
                Not required — a scorer judges the output directly.
              </p>
            )}
          </Block>

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
            <label htmlFor="corrected-expected" className="mb-1.5 block font-medium">
              Corrected expected output{" "}
              <span className="font-normal text-muted-foreground">optional</span>
            </label>
            <Input
              id="corrected-expected"
              value={corrected}
              onChange={(event) => setCorrected(event.target.value)}
              placeholder={target.expected ?? "e.g. billing"}
              className="h-7 text-[12px]"
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              This one does change things: it updates what future runs are compared against.
            </p>
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
          <span className="text-[11px] text-muted-foreground">Saved in this page only.</span>
          <span className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button size="sm" className="h-7 text-[12px]" onClick={handleSave}>
              Save review
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
