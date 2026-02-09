"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface BreadcrumbItem {
  label: string;
  href?: string;
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
 */
export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <div className="flex items-center gap-1.5 text-[13px]">
      {items.map((item, index) => (
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          {item.href ? (
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
