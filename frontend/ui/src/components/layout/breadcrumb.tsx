"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export interface BreadcrumbDropdownOption {
  id: string;
  label: string;
  href: string;
  /** True when this option represents the entity currently in view. */
  isCurrent?: boolean;
  /** Optional settings page for the entity, shown as a gear on the row. */
  settingsHref?: string;
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
  /** When provided (and non-empty), the segment renders as a dropdown selector. */
  options?: BreadcrumbDropdownOption[];
  /** Bold first menu item linking to the entity list page (e.g. "Workspaces"). */
  menuHeader?: { label: string; href: string };
  /** Optional create action at the bottom of the dropdown (e.g. "New workspace"). */
  createNew?: { label: string; onSelect: () => void };
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

/**
 * Generic breadcrumb renderer - a pure UI primitive.
 *
 * Usage:
 * ```tsx
 * <Breadcrumb items={[
 *   { label: 'Home', href: '/' },
 *   { label: 'Projects', href: '/projects' },
 *   { label: 'Current Page' }  // no href = not a link
 * ]} />
 * ```
 *
 * Items with `options` render as a dropdown selector instead of a plain
 * link: a bold header link, a scrollable entity list with per-entity
 * settings shortcuts, and an optional create action.
 */
export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <div className="flex min-w-0 items-center gap-0.5 text-[13px]">
      {items.map((item, index) => (
        <span key={index} className="flex min-w-0 items-center gap-0.5">
          {index > 0 && (
            <span
              aria-hidden="true"
              className="shrink-0 select-none text-[13px] text-muted-foreground/40"
            >
              /
            </span>
          )}
          {item.options && item.options.length > 0 ? (
            <BreadcrumbDropdown item={item} />
          ) : item.href ? (
            <Link
              href={item.href}
              className="rounded-[2px] px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </Link>
          ) : (
            <span className="truncate px-2 py-1 font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function BreadcrumbDropdown({ item }: { item: BreadcrumbItem }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Radix refocuses the trigger when the menu closes, and browsers treat that
  // programmatic focus as :focus-visible, leaving a focus ring after mouse-only
  // interaction. Track the last input modality and prevent focus return for
  // pointer-driven closes; keyboard closes keep it.
  const usedKeyboard = useRef(false);
  const trackKeyboard = () => {
    usedKeyboard.current = true;
  };
  const trackPointer = () => {
    usedKeyboard.current = false;
  };

  // The gear stops propagation so the row's select (and its navigation)
  // doesn't fire, which also skips the menu's auto-close - close explicitly.
  const openSettings = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className="flex min-w-0 items-center gap-1 rounded-[2px] px-2 py-1 font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
        onKeyDownCapture={trackKeyboard}
        onPointerDownCapture={trackPointer}
      >
        <span className="truncate">{item.label}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onKeyDownCapture={trackKeyboard}
        onPointerDownCapture={trackPointer}
        onPointerDownOutside={trackPointer}
        onCloseAutoFocus={(event) => {
          if (!usedKeyboard.current) event.preventDefault();
        }}
      >
        {item.menuHeader && (
          <>
            <DropdownMenuItem asChild className="text-[13px] font-medium">
              <Link href={item.menuHeader.href}>{item.menuHeader.label}</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <div className="max-h-36 overflow-y-auto">
          {item.options?.map((option) =>
            option.isCurrent ? (
              <DropdownMenuItem
                key={option.id}
                className="bg-accent text-[13px] text-foreground"
                onSelect={(event) => event.preventDefault()}
              >
                <BreadcrumbOptionContent option={option} onOpenSettings={openSettings} />
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={option.id} asChild className="text-[13px]">
                <Link href={option.href}>
                  <BreadcrumbOptionContent option={option} onOpenSettings={openSettings} />
                </Link>
              </DropdownMenuItem>
            ),
          )}
        </div>
        {item.createNew && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={item.createNew.onSelect} className="text-[13px]">
              <Plus className="h-3.5 w-3.5 shrink-0" />
              {item.createNew.label}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BreadcrumbOptionContent({
  option,
  onOpenSettings,
}: {
  option: BreadcrumbDropdownOption;
  onOpenSettings: (href: string) => void;
}) {
  return (
    <span className="flex w-full items-center justify-between">
      <span className="flex min-w-0 items-center pl-6">
        <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
          {option.isCurrent && <Check aria-hidden="true" className="h-4 w-4" />}
        </span>
        <span className="max-w-36 truncate" title={option.label}>
          {option.label}
        </span>
      </span>
      {option.settingsHref && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenSettings(option.settingsHref!);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onOpenSettings(option.settingsHref!);
            }
          }}
          className="-my-0.5 ml-4 flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <Settings size={12} />
        </span>
      )}
    </span>
  );
}
