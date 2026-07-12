"use client";

import * as React from "react";
import {
  ArrowUp,
  ArrowDown,
  Expand,
  Shrink,
  SquareArrowOutUpRight,
  BotMessageSquare,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { CopyButton } from "./copy-button";

/**
 * Optional action group passed to {@link PanelHeader}. Each group renders only
 * when its prop is provided, so the same component serves both the trace viewer
 * (full action set) and the detector panel (nav + close only).
 */
export interface PanelHeaderNavAction {
  onNavigate: (direction: "up" | "down") => void;
  canUp: boolean;
  canDown: boolean;
  upTitle?: string;
  downTitle?: string;
}

export interface PanelHeaderFullscreenAction {
  isFullscreen: boolean;
  onToggle: () => void;
}

export interface PanelHeaderNewTabAction {
  /** URL opened via `window.open(..., "_blank")` on click. */
  href: string;
  title?: string;
}

export interface PanelHeaderAiAction {
  /** Whether the AI panel is currently open. Reserved for an active-state style; not yet read. */
  open: boolean;
  onClick: () => void;
  title?: string;
}

export interface PanelHeaderAlertAction {
  onClick: () => void;
  title?: string;
  /** Button label text; defaults to "Alert". */
  label?: string;
}

export interface PanelHeaderCloseAction {
  onClose: () => void;
  title?: string;
}

export interface PanelHeaderProps {
  /** Leading icon element (e.g. <Workflow className="h-4 w-4 ..." />). */
  icon: React.ReactNode;
  /** Entity label, e.g. "Trace" / "Detector". */
  label: string;
  /** Entity ID — shown in mono and wired to the shared CopyButton. */
  id: string;
  /** Title for the copy affordance, e.g. "Copy trace ID". */
  copyTitle: string;
  /** Optional display name shown between the label and the ID. */
  name?: string;
  /** Red "Alert" button — rendered only when provided. */
  alert?: PanelHeaderAlertAction;
  /** Previous/next navigation — rendered only when provided. */
  nav?: PanelHeaderNavAction;
  /** Fullscreen expand/restore — rendered only when provided. */
  fullscreen?: PanelHeaderFullscreenAction;
  /** Open-in-new-tab — rendered only when provided. */
  newTab?: PanelHeaderNewTabAction;
  /** AI assistant toggle — rendered only when provided. */
  ai?: PanelHeaderAiAction;
  /** Close button — rendered only when provided. */
  close?: PanelHeaderCloseAction;
  className?: string;
}

/**
 * Shared detail-panel header. Pure/presentational — all data and callbacks come
 * through props, so it has no context or hook dependencies beyond CopyButton's
 * own internal copied-state and is straightforward to unit-test.
 *
 * Action groups render in a fixed order (alert · nav · fullscreen · new-tab ·
 * gap · ai · close) and only when their prop is supplied, making this a drop-in
 * for the trace viewer header (full set) and the detector panel header (subset).
 */
export function PanelHeader({
  icon,
  label,
  id,
  copyTitle,
  name,
  alert,
  nav,
  fullscreen,
  newTab,
  ai,
  close,
  className,
}: PanelHeaderProps) {
  return (
    <div
      className={cn(
        "flex h-14 flex-shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="text-sm font-medium">{label}</span>
        {name && <span className="truncate text-sm text-muted-foreground">{name}</span>}
        <span className="truncate font-mono text-xs text-muted-foreground">{id}</span>
        <CopyButton
          value={id}
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          title={copyTitle}
        />
      </div>
      <div className="flex items-center gap-1">
        {alert && (
          <button
            type="button"
            onClick={alert.onClick}
            className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60"
            title={alert.title ?? "Findings detected — open root cause analysis"}
          >
            {alert.label ?? "Alert"}
          </button>
        )}
        {nav && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => nav.onNavigate("up")}
              disabled={!nav.canUp}
              className="h-7 w-7 p-0"
              title={nav.upTitle ?? "Previous"}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => nav.onNavigate("down")}
              disabled={!nav.canDown}
              className="h-7 w-7 p-0"
              title={nav.downTitle ?? "Next"}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </>
        )}
        {fullscreen && (
          <Button
            variant="outline"
            size="sm"
            onClick={fullscreen.onToggle}
            className="h-7 w-7 p-0"
            title={fullscreen.isFullscreen ? "Restore default size" : "Expand to full screen"}
          >
            {fullscreen.isFullscreen ? (
              <Shrink className="h-4 w-4" />
            ) : (
              <Expand className="h-4 w-4" />
            )}
          </Button>
        )}
        {newTab && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(newTab.href, "_blank")}
            className="h-7 w-7 p-0"
            title={newTab.title ?? "Open in new tab"}
          >
            <SquareArrowOutUpRight className="h-4 w-4" />
          </Button>
        )}
        {(ai || close) && <div className="w-2" />}
        {ai && (
          <Button
            variant="outline"
            size="sm"
            onClick={ai.onClick}
            className="h-7 w-7 p-0"
            title={ai.title ?? "AI Assistant"}
          >
            <BotMessageSquare className="h-4 w-4" />
          </Button>
        )}
        {close && (
          <Button
            variant="ghost"
            size="sm"
            onClick={close.onClose}
            className="h-7 w-7 p-0"
            title={close.title ?? "Close"}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
