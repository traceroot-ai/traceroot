// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CopyButton } from "./copy-button";
import { DeleteIconButton } from "./delete-button";
import { CodeBlock } from "@/features/traces/components/GettingStarted/CodeBlock";

afterEach(cleanup);

it("names icon buttons when a caller omits a label", () => {
  render(
    <>
      <CopyButton value="example" />
      <DeleteIconButton />
    </>,
  );
  expect(screen.getByRole("button", { name: "Copy" }).title).toBe("Copy");
  expect(screen.getByRole("button", { name: "Delete" }).title).toBe("Delete");
});

it("uses contextual labels and preserves caller tooltips", () => {
  render(
    <>
      <CopyButton value="example" title="Copy code" />
      <DeleteIconButton aria-label="Remove member Alice" title="Remove Alice" />
    </>,
  );
  expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove member Alice" }).title).toBe("Remove Alice");
});

it("keeps fallback names when optional labels are explicitly undefined", () => {
  render(
    <>
      <CopyButton value="example" aria-label={undefined} title={undefined} />
      <DeleteIconButton aria-label={undefined} title={undefined} />
    </>,
  );
  expect(screen.getByRole("button", { name: "Copy" }).title).toBe("Copy");
  expect(screen.getByRole("button", { name: "Delete" }).title).toBe("Delete");
});

it("uses the supplied name or tooltip when the other is undefined", () => {
  render(
    <>
      <CopyButton value="example" aria-label={undefined} title="Copy trace ID" />
      <DeleteIconButton aria-label="Remove member Alice" title={undefined} />
    </>,
  );
  expect(screen.getByRole("button", { name: "Copy trace ID" }).title).toBe("Copy trace ID");
  expect(screen.getByRole("button", { name: "Remove member Alice" }).title).toBe(
    "Remove member Alice",
  );
});

it("identifies code copy actions by their snippet heading", () => {
  render(
    <>
      <CodeBlock label="bash" value="pip install traceroot" />
      <CodeBlock label="python" value="import traceroot" />
    </>,
  );
  expect(screen.getByRole("button", { name: "Copy bash snippet" }).title).toBe("Copy bash snippet");
  expect(screen.getByRole("button", { name: "Copy python snippet" }).title).toBe(
    "Copy python snippet",
  );
});
