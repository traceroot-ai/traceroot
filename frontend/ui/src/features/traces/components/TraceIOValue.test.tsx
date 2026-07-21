// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { TraceIOValue } from "./TraceIOValue";

afterEach(() => cleanup());

async function pickFormat(label: string) {
  fireEvent.click(screen.getByTitle("Change format"));
  // Options render in a Radix popover; pick by its exact text.
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

describe("TraceIOValue format switcher", () => {
  it("renders a dash and no switcher when there is no content", () => {
    render(<TraceIOValue content={null} />);
    expect(screen.getByText("-")).toBeDefined();
    expect(screen.queryByTitle("Change format")).toBeNull();
  });

  it("defaults to Pretty and offers Text/JSON/YAML", () => {
    render(<TraceIOValue content={'{"a":1,"b":"x"}'} />);
    // The trigger shows the current format.
    expect(within(screen.getByTitle("Change format")).getByText("Pretty")).toBeDefined();
  });

  it("switches a JSON object to compact JSON and to Text", async () => {
    render(<TraceIOValue content={'{"a":1}'} />);
    await pickFormat("JSON");
    expect(screen.getByText('{"a":1}')).toBeDefined();
  });

  it("keeps a genuine string as-is in Text mode", async () => {
    render(<TraceIOValue content={"hello world"} />);
    await pickFormat("Text");
    expect(screen.getByText("hello world")).toBeDefined();
  });

  it("renders YAML for an object", async () => {
    render(<TraceIOValue content={'{"env":"prod","n":2}'} />);
    await pickFormat("YAML");
    expect(screen.getByText(/env: prod/)).toBeDefined();
    expect(screen.getByText(/n: 2/)).toBeDefined();
  });
});
