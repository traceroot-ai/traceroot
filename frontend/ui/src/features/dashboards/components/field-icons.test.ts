import { describe, expect, it } from "vitest";
import { AlertCircle, Box, CircleDollarSign, CircleStop, Clock, Globe } from "lucide-react";
import { fieldIcon } from "./field-icons";

describe("fieldIcon", () => {
  it("mirrors the trace-list filter icons for shared fields", () => {
    expect(fieldIcon("cost")).toBe(CircleDollarSign);
    expect(fieldIcon("total_tokens")).toBe(CircleStop);
    expect(fieldIcon("duration_ms")).toBe(Clock);
    expect(fieldIcon("environment")).toBe(Globe);
    expect(fieldIcon("model_name")).toBe(Box);
  });

  it("maps the widget registry's own spellings and token variants", () => {
    expect(fieldIcon("error_count")).toBe(AlertCircle);
    expect(fieldIcon("input_tokens")).toBe(CircleStop);
    expect(fieldIcon("output_tokens")).toBe(CircleStop);
  });

  it("falls back to the generic box like the trace list does", () => {
    expect(fieldIcon("span_kind")).toBe(Box);
    expect(fieldIcon("name")).toBe(Box);
  });
});
