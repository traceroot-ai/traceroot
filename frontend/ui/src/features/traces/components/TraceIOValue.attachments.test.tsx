// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TraceIOSection } from "./TraceIOValue";

afterEach(() => cleanup());

const HASH = "cd".repeat(32);
const REF = `traceroot-attachment://v1/sha256/${HASH}?mime=image/jpeg&bytes=10`;

describe("TraceIOSection attachment source", () => {
  it("loads references through the span it is given", () => {
    render(
      <TraceIOSection
        title="Output"
        content={JSON.stringify({ image: REF })}
        attachmentSource={{ projectId: "p", traceId: "t", spanId: "s" }}
      />,
    );
    expect(screen.getByRole("img").getAttribute("src")).toBe(
      `/api/projects/p/traces/t/spans/s/attachments/${HASH}`,
    );
  });

  it("leaves references as text without one", () => {
    render(<TraceIOSection title="Output" content={JSON.stringify({ image: REF })} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(`"${REF}"`)).toBeDefined();
  });
});
