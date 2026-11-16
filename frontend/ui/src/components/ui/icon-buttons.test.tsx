// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CopyButton } from "./copy-button";
import { DeleteIconButton } from "./delete-button";

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
