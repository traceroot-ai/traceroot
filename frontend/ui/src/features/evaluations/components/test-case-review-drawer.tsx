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
import type { ReviewStatus } from "../types";

/**
 * Review test case — server-wired port of the prototype's drawer. Identical
 * chrome and checklist; the only changes are that submitting no longer fires a
 * "prototype only" toast (the caller persists through useUpdateTestCase and
 * shows a real toast) and the advisory copy no longer says "saved here only".
 * Reviewing verifies a row is a good, reusable test case — a different question
 * from scoring one output — and may correct the expected outcome. Ready is
 * advisory: it never blocks the case from an evaluation.
 */

export interface TestCaseReviewTarget {
  contextLabel: string;
  input: string;
  expected: string | null;
  currentReview: ReviewStatus;
}

const CHECKS = [
  "The input is sufficient and rerunnable.",
  "The case belongs in this dataset.",
  "The expected outcome is correct, or intentionally not required.",
  "Sensitive or irrelevant production data has been removed.",
  "The source span provides the intended test boundary.",
];

export function TestCaseReviewDrawer({
  target,
  open,
  onOpenChange,
  onSubmit,
}: {
  target: TestCaseReviewTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (result: { review: ReviewStatus; correctedExpected?: string }) => void;
}) {
  const [checked, setChecked] = React.useState<boolean[]>(() => CHECKS.map(() => false));
  const [corrected, setCorrected] = React.useState("");

  React.useEffect(() => {
    if (!open || !target) return;
    setChecked(CHECKS.map(() => false));
    setCorrected("");
  }, [open, target]);

  if (!target) return null;

  const expectedChanged = corrected.trim() !== "" && corrected.trim() !== (target.expected ?? "");

  const submit = (review: ReviewStatus) => {
    onSubmit({ review, correctedExpected: expectedChanged ? corrected.trim() : undefined });
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width="w-[560px]">
        <DrawerHeader className="pr-10">
          <DrawerTitle>Review test case</DrawerTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">{target.contextLabel}</p>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-4 text-[12px]">
          <p className="leading-relaxed text-muted-foreground">
            Confirm this is a good, reusable test case — not whether one run passed. Output scoring
            (Pass / Fail / quality) happens elsewhere.
          </p>

          <div>
            <p className="mb-1 text-[11px] text-muted-foreground">Input</p>
            <div className="rounded border border-border bg-muted/20 px-2.5 py-2 leading-relaxed">
              {target.input || <span className="text-muted-foreground">—</span>}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[11px] text-muted-foreground">Expected outcome</p>
            <div className="rounded border border-border bg-muted/20 px-2.5 py-2 leading-relaxed">
              {target.expected ? (
                target.expected
              ) : (
                <span className="text-muted-foreground">
                  Not required — a scorer judges the output directly.
                </span>
              )}
            </div>
          </div>

          <div className="h-px bg-border" />

          <div>
            <p className="mb-2 font-medium">Verify</p>
            <ul className="flex flex-col gap-2">
              {CHECKS.map((label, i) => (
                <li key={label}>
                  <label className="flex cursor-pointer items-start gap-2 leading-relaxed">
                    <input
                      type="checkbox"
                      checked={checked[i]}
                      onChange={(e) =>
                        setChecked((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)))
                      }
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-foreground"
                    />
                    <span>{label}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <label htmlFor="tc-corrected-expected" className="mb-1.5 block font-medium">
              Correct the expected outcome{" "}
              <span className="font-normal text-muted-foreground">optional</span>
            </label>
            <Input
              id="tc-corrected-expected"
              value={corrected}
              onChange={(event) => setCorrected(event.target.value)}
              placeholder={target.expected ?? "e.g. billing"}
              className="h-7 text-[12px]"
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Changing this publishes a new dataset version — it changes what future runs are
              evaluated against.
            </p>
          </div>
        </DrawerBody>

        <DrawerFooter>
          <span className="text-[11px] text-muted-foreground">
            Ready is advisory — it never blocks the case from an evaluation.
          </span>
          <span className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => submit("needs_review")}
            >
              Needs work
            </Button>
            <Button size="sm" className="h-7 text-[12px]" onClick={() => submit("ready")}>
              Mark ready
            </Button>
          </span>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
