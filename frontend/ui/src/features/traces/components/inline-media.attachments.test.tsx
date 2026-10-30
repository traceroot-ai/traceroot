// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AttachmentImage,
  AttachmentSourceContext,
  attachmentHash,
  attachmentUrl,
  mediaSrc,
  type AttachmentSource,
} from "./inline-media";

afterEach(() => cleanup());

const HASH = "0123456789abcdef".repeat(4);
const OTHER = "f".repeat(64);
const ref = (hash = HASH, mime = "image/png", bytes = 1234) =>
  `traceroot-attachment://v1/sha256/${hash}?mime=${mime}&bytes=${bytes}`;
const SOURCE: AttachmentSource = { projectId: "proj-1", traceId: "trace-1", spanId: "span-1" };
const URL_FOR = (hash: string) =>
  `/api/projects/proj-1/traces/trace-1/spans/span-1/attachments/${hash}`;

describe("attachmentHash", () => {
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "reads the hash from a %s reference",
    (mime) => {
      expect(attachmentHash(ref(HASH, mime))).toBe(HASH);
    },
  );

  it.each([
    ["embedded in text", `see ${ref()}`],
    ["followed by text", `${ref()} done`],
    ["an uppercase hash", ref(HASH.toUpperCase())],
    ["a short hash", ref(HASH.slice(1))],
    ["no byte count", `traceroot-attachment://v1/sha256/${HASH}?mime=image/png`],
    ["no query", `traceroot-attachment://v1/sha256/${HASH}`],
    ["an SVG type", ref(HASH, "image/svg+xml")],
    ["the jpg alias", ref(HASH, "image/jpg")],
    ["another version", ref().replace("/v1/", "/v2/")],
    ["a data URI", "data:image/png;base64,iVBORw0KGgo="],
    ["plain text", "hello"],
  ])("is null for %s", (_name, value) => {
    expect(attachmentHash(value)).toBeNull();
  });
});

describe("attachmentUrl", () => {
  it("points at the same-origin proxy route for the span", () => {
    expect(attachmentUrl(SOURCE, HASH)).toBe(URL_FOR(HASH));
  });

  it("encodes each id as one path segment", () => {
    expect(attachmentUrl({ projectId: "p 1", traceId: "t/1", spanId: "s?#" }, HASH)).toBe(
      `/api/projects/p%201/traces/t%2F1/spans/s%3F%23/attachments/${HASH}`,
    );
  });
});

describe("data URIs are unchanged", () => {
  it("still renders a data URI as itself", () => {
    const uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    expect(mediaSrc(uri)).toEqual({ src: uri, kind: "image" });
  });

  it("does not treat a reference as inline media", () => {
    expect(mediaSrc(ref())).toBeNull();
  });
});

describe("AttachmentImage", () => {
  it("renders the fallback when no span is known", () => {
    render(<AttachmentImage hash={HASH} fallback={<span>raw reference</span>} />);
    expect(screen.getByText("raw reference")).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("lazy-loads the image through the proxy for the known span", () => {
    render(
      <AttachmentSourceContext.Provider value={SOURCE}>
        <AttachmentImage hash={HASH} fallback={<span>raw reference</span>} />
      </AttachmentSourceContext.Provider>,
    );
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(URL_FOR(HASH));
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("alt")).toBe("Span image");
    expect(screen.queryByText("raw reference")).toBeNull();
  });

  it("shows an unavailable state instead of a broken image", () => {
    render(
      <AttachmentSourceContext.Provider value={SOURCE}>
        <AttachmentImage hash={HASH} fallback={null} />
      </AttachmentSourceContext.Provider>,
    );
    fireEvent.error(screen.getByRole("img"));

    expect(screen.getByText("Image unavailable")).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("tries again when a different image takes its place", () => {
    const { rerender } = render(
      <AttachmentSourceContext.Provider value={SOURCE}>
        <AttachmentImage hash={HASH} fallback={null} />
      </AttachmentSourceContext.Provider>,
    );
    fireEvent.error(screen.getByRole("img"));

    rerender(
      <AttachmentSourceContext.Provider value={SOURCE}>
        <AttachmentImage hash={OTHER} fallback={null} />
      </AttachmentSourceContext.Provider>,
    );

    expect(screen.getByRole("img").getAttribute("src")).toBe(URL_FOR(OTHER));
  });
});
