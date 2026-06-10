"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus, Settings, Slash } from "lucide-react";
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
    <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
      {items.map((item, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && <Slash className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
          {item.options && item.options.length > 0 ? (
            <BreadcrumbDropdown item={item} />
          ) : item.href ? (
            <Link
              href={item.href}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </Link>
          ) : (
            <span className="truncate font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function BreadcrumbDropdown({ item }: { item: BreadcrumbItem }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // The gear stops propagation so the row's select (and its navigation)
  // doesn't fire, which also skips the menu's auto-close - close explicitly.
  const openSettings = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="flex min-w-0 items-center gap-1 font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span className="truncate">{item.label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="rounded-none">
        {item.menuHeader && (
          <>
            <DropdownMenuItem asChild className="rounded-none text-[13px] font-semibold">
              <Link href={item.menuHeader.href}>{item.menuHeader.label}</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <div className="max-h-36 overflow-y-auto">
          {item.options?.map((option) => (
            <DropdownMenuItem key={option.id} asChild className="rounded-none text-[13px]">
              <Link href={option.href} className="flex justify-between">
                <span className="max-w-36 truncate" title={option.label}>
                  {option.label}
                </span>
                {option.settingsHref && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openSettings(option.settingsHref!);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        openSettings(option.settingsHref!);
                      }
                    }}
                    className="-my-0.5 ml-4 flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  >
                    <Settings size={12} />
                  </span>
                )}
              </Link>
            </DropdownMenuItem>
          ))}
        </div>
        {item.createNew && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={item.createNew.onSelect}
              className="rounded-none text-[13px]"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              {item.createNew.label}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
