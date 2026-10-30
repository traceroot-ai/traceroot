// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { JsonRenderer } from "./JsonRenderer";
import { ContentRenderer } from "./ContentRenderer";
import { AttachmentSourceContext } from "./inline-media";

afterEach(() => cleanup());

const HASH = "ab".repeat(32);
const REF = `traceroot-attachment://v1/sha256/${HASH}?mime=image/png&bytes=68`;
const DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const SOURCE = { projectId: "proj-1", traceId: "trace-1", spanId: "span-1" };
const PROXY = `/api/projects/proj-1/traces/trace-1/spans/span-1/attachments/${HASH}`;

function inSpan(node: ReactNode) {
  return render(
    <AttachmentSourceContext.Provider value={SOURCE}>{node}</AttachmentSourceContext.Provider>,
  );
}

describe("JsonRenderer attachment references", () => {
  it("renders a reference value inside an object as the image", () => {
    inSpan(<JsonRenderer value={{ type: "image_url", image_url: { url: REF } }} />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(PROXY);
  });

  it("renders a reference inside a stringified-JSON value", () => {
    inSpan(<JsonRenderer value={JSON.stringify([{ type: "input_image", image_url: REF }])} />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(PROXY);
  });

  it("keeps a reference inside longer text as text", () => {
    inSpan(<JsonRenderer value={`screenshot: ${REF}`} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(`"screenshot: ${REF}"`)).toBeDefined();
  });

  it("keeps a reference as text when no span is known", () => {
    render(<JsonRenderer value={{ url: REF }} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(`"${REF}"`)).toBeDefined();
  });

  it("renders data URIs exactly as before", () => {
    inSpan(<JsonRenderer value={{ url: DATA_URI }} />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe(DATA_URI);
    expect(img.getAttribute("alt")).toBe("Inline image");
    expect(img.getAttribute("loading")).toBeNull();
  });
});

describe("ContentRenderer attachment references", () => {
  it("renders content that is only a reference as the image", () => {
    inSpan(<ContentRenderer content={REF} />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(PROXY);
  });

  it("renders content that is only a data URI exactly as before", () => {
    inSpan(<ContentRenderer content={DATA_URI} />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(DATA_URI);
  });
});
