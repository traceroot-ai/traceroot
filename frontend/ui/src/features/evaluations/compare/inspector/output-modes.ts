/** How the trace panel compares a case's outputs. */
export type OutputMode = "side_by_side" | "inline" | "vs_expected";

export const OUTPUT_MODES: { value: OutputMode; label: string }[] = [
  { value: "side_by_side", label: "Side by side" },
  { value: "inline", label: "Inline diff" },
  { value: "vs_expected", label: "Candidate vs expected" },
];
