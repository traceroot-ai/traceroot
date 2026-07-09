// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GitHubStarWidget } from "@/components/layout/GitHubStarWidget";

// React's act() warning gate; required for effects to flush synchronously
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("GitHubStarWidget", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render() {
    act(() => {
      root.render(<GitHubStarWidget />);
    });
  }

  it("renders the card with copy and star link once mounted", () => {
    // Fresh star-count cache so the widget skips the GitHub API fetch
    localStorage.setItem(
      "github-star-count-cache",
      JSON.stringify({ count: 614, timestamp: Date.now() }),
    );

    render();

    expect(container.textContent).toContain("Star TraceRoot");
    expect(container.textContent).toContain("Open source and shipping fast.");
    expect(container.textContent).toContain("Made with ❤️ by contributors.");
    expect(container.textContent).toContain("614");

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toContain("github.com");
  });

  it("stays hidden when previously dismissed", () => {
    localStorage.setItem("github-star-widget-dismissed", "true");

    render();

    expect(container.textContent).not.toContain("Star TraceRoot");
  });

  it("dismisses on close click and persists the choice", () => {
    localStorage.setItem(
      "github-star-count-cache",
      JSON.stringify({ count: 614, timestamp: Date.now() }),
    );

    render();

    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]');
    expect(dismiss).not.toBeNull();
    act(() => {
      dismiss!.click();
    });

    expect(container.textContent).not.toContain("Star TraceRoot");
    expect(localStorage.getItem("github-star-widget-dismissed")).toBe("true");
  });

  it("fetches the star count when the cache is stale", async () => {
    localStorage.setItem(
      "github-star-count-cache",
      JSON.stringify({ count: 1, timestamp: Date.now() - 2 * 60 * 60 * 1000 }),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ stargazers_count: 1500 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render();
    // flush the fetch promise chain
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/traceroot-ai/traceroot");
    expect(container.textContent).toContain("1.5k");
  });
});
