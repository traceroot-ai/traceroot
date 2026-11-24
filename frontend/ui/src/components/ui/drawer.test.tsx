// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "./drawer";

afterEach(() => cleanup());

const drawer = (portal?: boolean) => (
  <div data-testid="host">
    <Drawer open>
      <DrawerContent portal={portal}>
        <DrawerTitle>Title</DrawerTitle>
        <DrawerDescription>Description</DrawerDescription>
      </DrawerContent>
    </Drawer>
  </div>
);

describe("DrawerContent", () => {
  it("portals to the document body by default", () => {
    render(drawer());
    expect(screen.getByTestId("host").contains(screen.getByRole("dialog"))).toBe(false);
  });

  it("renders in place when asked, so it sees the CSS variables its host defines", () => {
    render(drawer(false));
    expect(screen.getByTestId("host").contains(screen.getByRole("dialog"))).toBe(true);
  });
});
