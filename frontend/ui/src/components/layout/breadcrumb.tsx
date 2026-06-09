"use client";

import Link from "next/link";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
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
  /** Option id to mark as current in the dropdown. */
  selectedId?: string;
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
 * link; selecting an option navigates to its href.
 */
export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <div className="flex items-center gap-1.5 text-[13px]">
      {items.map((item, index) => (
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          {item.options && item.options.length > 0 ? (
            <BreadcrumbDropdown item={item} />
          ) : item.href ? (
            <Link href={item.href} className="hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function BreadcrumbDropdown({ item }: { item: BreadcrumbItem }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-0.5 rounded-sm hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {item.label}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {item.options?.map((option) => (
          <DropdownMenuItem key={option.id} asChild>
            <Link href={option.href}>
              <span className="flex-1 truncate">{option.label}</span>
              {option.id === item.selectedId && <Check className="h-3.5 w-3.5 shrink-0" />}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
