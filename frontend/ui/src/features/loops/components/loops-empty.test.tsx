// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LoopsEmpty } from "./loops-empty";

afterEach(cleanup);

describe("LoopsEmpty", () => {
  it("says there are no loops and links to the new loop form", () => {
    render(<LoopsEmpty projectId="p1" />);
    expect(screen.getByText("No loops yet")).toBeTruthy();
    expect(screen.getByText("Create a loop to review your traces on a schedule.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "New loop" }).getAttribute("href")).toBe(
      "/projects/p1/loops/new",
    );
  });

  it("offers no one-click start, so nothing is created from the empty state", () => {
    render(<LoopsEmpty projectId="p1" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
