import { describe, expect, it } from "vitest";
import {
  AlertCircle,
  Box,
  CircleCheck,
  CircleDollarSign,
  CircleStop,
  Clock,
  Globe,
  Hash,
  Layers,
  Shapes,
  Users,
  Workflow,
} from "lucide-react";
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

  it("gives count its own symbol and mirrors the trace-page tabs for user/session", () => {
    // count must not fall back to Box — that doubles as the model icon.
    expect(fieldIcon("count")).toBe(Hash);
    expect(fieldIcon("user_id")).toBe(Users);
    expect(fieldIcon("session_id")).toBe(Layers);
  });

  it("uses the sidebar's Tracing symbol for the trace/span name field", () => {
    expect(fieldIcon("name")).toBe(Workflow);
  });

  it("uses the shapes symbol for span kind", () => {
    expect(fieldIcon("span_kind")).toBe(Shapes);
  });

  it("uses the check circle for status", () => {
    expect(fieldIcon("status")).toBe(CircleCheck);
  });

  it("falls back to the generic box like the trace list does", () => {
    expect(fieldIcon("some_future_field")).toBe(Box);
  });
});
