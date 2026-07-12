// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PanelHeader } from "./panel-header";

const writeText = vi.fn().mockResolvedValue(undefined);
const openSpy = vi.fn();

function stubEnv() {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  Object.defineProperty(window, "open", { value: openSpy, configurable: true });
}

function renderHeader(overrides: Partial<React.ComponentProps<typeof PanelHeader>> = {}) {
  return render(
    <PanelHeader
      icon={<span data-testid="header-icon">ICN</span>}
      label="Trace"
      id="trace-123"
      copyTitle="Copy trace ID"
      {...overrides}
    />,
  );
}

describe("PanelHeader", () => {
  beforeEach(() => {
    writeText.mockClear();
    openSpy.mockClear();
    stubEnv();
  });
  afterEach(() => cleanup());

  describe("left side", () => {
    it("renders icon, label, and id", () => {
      renderHeader();
      expect(screen.getByTestId("header-icon")).toBeTruthy();
      expect(screen.getByText("Trace")).toBeTruthy();
      expect(screen.getByText("trace-123")).toBeTruthy();
    });

    it("renders the optional name between label and id", () => {
      renderHeader({ name: "my-detector" });
      expect(screen.getByText("my-detector")).toBeTruthy();
    });

    it("omits the name when not provided", () => {
      renderHeader();
      expect(screen.queryByText("my-detector")).toBeNull();
    });

    it("uses the h-14 shell with shared header styling", () => {
      const { container } = renderHeader();
      const shell = container.firstElementChild as HTMLElement;
      expect(shell.className).toContain("h-14");
      expect(shell.className).toContain("bg-muted/30");
      expect(shell.className).toContain("border-b");
    });

    it("applies issue #1219 label + ID text classes", () => {
      renderHeader();
      // Label: text-sm font-medium
      expect(screen.getByText("Trace").className).toBe("text-sm font-medium");
      // ID: font-mono text-xs text-muted-foreground (component also adds `truncate`)
      const idClass = screen.getByText("trace-123").className;
      expect(idClass).toContain("font-mono");
      expect(idClass).toContain("text-xs");
      expect(idClass).toContain("text-muted-foreground");
    });

    it("merges className via cn and lets it override the base height", () => {
      const { container } = renderHeader({ className: "h-10 bg-red-500" });
      const shell = container.firstElementChild as HTMLElement;
      // twMerge resolves the h-14 vs h-10 conflict in favour of the override.
      expect(shell.className).toContain("h-10");
      expect(shell.className).toContain("bg-red-500");
      expect(shell.className).not.toContain("h-14");
      expect(shell.className).not.toContain("bg-muted/30");
    });
  });

  describe("copy button", () => {
    it("copies the id to the clipboard", () => {
      renderHeader();
      fireEvent.click(screen.getByRole("button", { name: /copy trace id/i }));
      expect(writeText).toHaveBeenCalledWith("trace-123");
    });

    it("flips the icon to the green check after copying", async () => {
      const { container } = renderHeader();
      // Before click: no green check icon.
      expect(container.querySelector('[class*="text-green-600"]')).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /copy trace id/i }));
      // After click: CopyButton's async handler sets copied=true (microtask),
      // swapping the Copy svg for the Check svg with text-green-600.
      await waitFor(() => {
        expect(container.querySelector('[class*="text-green-600"]')).toBeTruthy();
      });
    });
  });

  describe("alert", () => {
    it("renders only when provided and fires onClick", () => {
      const onClick = vi.fn();
      const { rerender } = render(
        <PanelHeader
          icon={<span data-testid="header-icon">ICN</span>}
          label="Trace"
          id="trace-123"
          copyTitle="Copy trace ID"
        />,
      );
      expect(screen.queryByRole("button", { name: /^alert$/i })).toBeNull();

      rerender(
        <PanelHeader
          icon={<span data-testid="header-icon">ICN</span>}
          label="Trace"
          id="trace-123"
          copyTitle="Copy trace ID"
          alert={{ onClick }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /^alert$/i }));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it("supports a custom label and title", () => {
      renderHeader({ alert: { onClick: vi.fn(), label: "RCA", title: "open rca" } });
      const alert = screen.getByRole("button", { name: /rca/i });
      expect(alert.getAttribute("title")).toBe("open rca");
    });

    it("uses the default title and 'Alert' label when omitted", () => {
      renderHeader({ alert: { onClick: vi.fn() } });
      const alert = screen.getByRole("button", { name: /^alert$/i });
      expect(alert.textContent).toBe("Alert");
      expect(alert.getAttribute("title")).toBe("Findings detected — open root cause analysis");
    });
  });

  describe("nav", () => {
    it("renders prev/next only when provided", () => {
      renderHeader();
      expect(screen.queryByRole("button", { name: /previous/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
    });

    it("calls onNavigate with up/down and respects disabled + titles", () => {
      const onNavigate = vi.fn();
      renderHeader({
        nav: {
          onNavigate,
          canUp: false,
          canDown: true,
          upTitle: "Previous trace",
          downTitle: "Next trace",
        },
      });
      const prev = screen.getByRole("button", { name: /previous trace/i }) as HTMLButtonElement;
      const next = screen.getByRole("button", { name: /next trace/i }) as HTMLButtonElement;
      expect(prev.disabled).toBe(true);
      expect(next.disabled).toBe(false);
      fireEvent.click(next);
      expect(onNavigate).toHaveBeenCalledWith("down");
      // Disabled prev must not fire onNavigate — React suppresses onClick on disabled buttons.
      fireEvent.click(prev);
      expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it("fires onNavigate('up') when prev is enabled", () => {
      const onNavigate = vi.fn();
      renderHeader({ nav: { onNavigate, canUp: true, canDown: false } });
      fireEvent.click(screen.getByRole("button", { name: /previous/i }));
      expect(onNavigate).toHaveBeenCalledWith("up");
      expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it("falls back to 'Previous' / 'Next' titles when none provided", () => {
      renderHeader({ nav: { onNavigate: vi.fn(), canUp: true, canDown: true } });
      expect(screen.getByRole("button", { name: /^previous$/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /^next$/i })).toBeTruthy();
    });
  });

  describe("fullscreen", () => {
    it("shows Expand + 'Expand to full screen' when not fullscreen", () => {
      const onToggle = vi.fn();
      renderHeader({ fullscreen: { isFullscreen: false, onToggle } });
      fireEvent.click(screen.getByRole("button", { name: /expand to full screen/i }));
      expect(onToggle).toHaveBeenCalledOnce();
    });

    it("shows 'Restore default size' when fullscreen", () => {
      renderHeader({ fullscreen: { isFullscreen: true, onToggle: vi.fn() } });
      expect(screen.getByRole("button", { name: /restore default size/i })).toBeTruthy();
    });

    it("fires onToggle when already fullscreen", () => {
      const onToggle = vi.fn();
      renderHeader({ fullscreen: { isFullscreen: true, onToggle } });
      fireEvent.click(screen.getByRole("button", { name: /restore default size/i }));
      expect(onToggle).toHaveBeenCalledOnce();
    });
  });

  describe("newTab", () => {
    it("opens the href in a new tab on click", () => {
      renderHeader({ newTab: { href: "http://example/trace-123?fullscreen=1" } });
      fireEvent.click(screen.getByRole("button", { name: /open in new tab/i }));
      expect(openSpy).toHaveBeenCalledWith("http://example/trace-123?fullscreen=1", "_blank");
    });

    it("supports a custom title", () => {
      renderHeader({ newTab: { href: "http://x", title: "pop out" } });
      expect(screen.getByRole("button", { name: /pop out/i }).getAttribute("title")).toBe(
        "pop out",
      );
    });
  });

  describe("ai", () => {
    it("renders only when provided and fires onClick", () => {
      const onClick = vi.fn();
      renderHeader();
      expect(screen.queryByRole("button", { name: /ai assistant/i })).toBeNull();

      renderHeader({ ai: { open: false, onClick } });
      fireEvent.click(screen.getByRole("button", { name: /ai assistant/i }));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it("supports a custom title", () => {
      renderHeader({ ai: { open: false, onClick: vi.fn(), title: "Ask agent" } });
      expect(screen.getByRole("button", { name: /ask agent/i }).getAttribute("title")).toBe(
        "Ask agent",
      );
    });
  });

  describe("close", () => {
    it("renders only when provided and fires onClose", () => {
      const onClose = vi.fn();
      renderHeader();
      expect(screen.queryByRole("button", { name: /close/i })).toBeNull();

      renderHeader({ close: { onClose } });
      fireEvent.click(screen.getByRole("button", { name: /close/i }));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("supports a custom title", () => {
      renderHeader({ close: { onClose: vi.fn(), title: "Dismiss" } });
      expect(screen.getByRole("button", { name: /dismiss/i }).getAttribute("title")).toBe(
        "Dismiss",
      );
    });
  });

  describe("action order + gap spacer", () => {
    function rightActions(container: HTMLElement): HTMLElement {
      // Shell's second child is the right-side actions container.
      return container.firstElementChild!.children[1] as HTMLElement;
    }

    it("renders action groups in the fixed order alert·nav·fullscreen·newTab·ai·close", () => {
      const { container } = renderHeader({
        alert: { onClick: vi.fn() },
        nav: { onNavigate: vi.fn(), canUp: true, canDown: true },
        fullscreen: { isFullscreen: false, onToggle: vi.fn() },
        newTab: { href: "http://x" },
        ai: { open: false, onClick: vi.fn() },
        close: { onClose: vi.fn() },
      });
      const titles = Array.from(rightActions(container).querySelectorAll("button")).map((b) =>
        b.getAttribute("title"),
      );
      expect(titles).toEqual([
        "Findings detected — open root cause analysis",
        "Previous",
        "Next",
        "Expand to full screen",
        "Open in new tab",
        "AI Assistant",
        "Close",
      ]);
    });

    it("renders the w-2 gap spacer only when ai or close is present", () => {
      // No ai/close → no spacer.
      let { container } = renderHeader({
        nav: { onNavigate: vi.fn(), canUp: true, canDown: true },
      });
      expect(rightActions(container).querySelector("div.w-2")).toBeNull();

      // close present → spacer rendered.
      ({ container } = renderHeader({ close: { onClose: vi.fn() } }));
      expect(rightActions(container).querySelector("div.w-2")).toBeTruthy();

      // ai present (no close) → spacer rendered.
      ({ container } = renderHeader({ ai: { open: false, onClick: vi.fn() } }));
      expect(rightActions(container).querySelector("div.w-2")).toBeTruthy();
    });
  });

  describe("full action set (trace header shape)", () => {
    it("renders all groups when every action is provided", () => {
      renderHeader({
        alert: { onClick: vi.fn() },
        nav: { onNavigate: vi.fn(), canUp: true, canDown: true },
        fullscreen: { isFullscreen: false, onToggle: vi.fn() },
        newTab: { href: "http://x" },
        ai: { open: false, onClick: vi.fn() },
        close: { onClose: vi.fn() },
      });
      expect(screen.getByRole("button", { name: /^alert$/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /previous/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /next/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /expand to full screen/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /open in new tab/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /ai assistant/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
    });
  });

  describe("detector header shape (nav + close only)", () => {
    it("renders name + id + copy + nav + close and no other actions", () => {
      renderHeader({
        icon: <span data-testid="header-icon">ICN</span>,
        label: "Detector",
        name: "Failure Detector",
        id: "det-1",
        copyTitle: "Copy detector ID",
        nav: { onNavigate: vi.fn(), canUp: true, canDown: true },
        close: { onClose: vi.fn() },
      });
      expect(screen.getByText("Detector")).toBeTruthy();
      expect(screen.getByText("Failure Detector")).toBeTruthy();
      expect(screen.getByText("det-1")).toBeTruthy();
      expect(screen.getByRole("button", { name: /copy detector id/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /previous/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
      // Actions the detector header must NOT show:
      expect(screen.queryByRole("button", { name: /alert/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /expand to full screen/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /open in new tab/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /ai assistant/i })).toBeNull();
    });
  });
});
