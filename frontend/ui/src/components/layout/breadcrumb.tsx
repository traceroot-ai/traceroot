"use client";

import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Plus } from "lucide-react";
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
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
  /** When provided (and non-empty), the segment renders as a dropdown selector. */
  options?: BreadcrumbDropdownOption[];
  /** Option id shown as the current selection at the top of the dropdown. */
  selectedId?: string;
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
 * link; selecting an option navigates to its href. Dropdown segments
 * stretch to the full header height so the panel opens flush with the
 * top bar, with the current selection pinned at the top of the panel.
 */
export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <div className="flex h-full min-w-0 items-stretch gap-0.5 text-[13px]">
      {items.map((item, index) => (
        <span key={index} className="flex min-w-0 items-center gap-0.5">
          {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
          {item.options && item.options.length > 0 ? (
            <BreadcrumbDropdown item={item} />
          ) : item.href ? (
            <Link
              href={item.href}
              className="flex h-full items-center px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {item.label}
            </Link>
          ) : (
            <span className="truncate px-1.5 py-1 font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function BreadcrumbDropdown({ item }: { item: BreadcrumbItem }) {
  const selected = item.options?.find((option) => option.id === item.selectedId);
  const others = item.options?.filter((option) => option.id !== item.selectedId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="group flex h-full min-w-0 items-center gap-1 px-2 font-medium outline-none transition-colors hover:bg-accent focus-visible:bg-accent data-[state=open]:bg-accent">
        <span className="truncate">{item.label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={0} className="w-64 rounded-none p-0 shadow-lg">
        {selected && (
          <>
            <div className="flex items-center gap-2 bg-accent/50 px-3 py-2.5 text-[13px] font-medium">
              <span className="flex-1 truncate">{selected.label}</span>
              <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </div>
            <DropdownMenuSeparator className="m-0" />
          </>
        )}
        {others?.map((option) => (
          <DropdownMenuItem key={option.id} asChild className="rounded-none px-3 py-2 text-[13px]">
            <Link href={option.href}>
              <span className="flex-1 truncate">{option.label}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        {item.createNew && (
          <>
            <DropdownMenuSeparator className="m-0" />
            <DropdownMenuItem
              onSelect={item.createNew.onSelect}
              className="rounded-none px-3 py-2 text-[13px] text-muted-foreground"
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
