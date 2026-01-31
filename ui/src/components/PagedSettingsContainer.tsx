"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

export interface SettingsPage {
  title: string;
  slug: string;
  content: React.ReactNode;
  show?: boolean;
}

interface PagedSettingsContainerProps {
  pages: SettingsPage[];
  basePath: string;
}

export function PagedSettingsContainer({
  pages,
  basePath,
}: PagedSettingsContainerProps) {
  const searchParams = useSearchParams();
  const activeSlug = searchParams.get("tab") || pages[0]?.slug || "general";

  const visiblePages = pages.filter((p) => p.show !== false);
  const activePage =
    visiblePages.find((p) => p.slug === activeSlug) || visiblePages[0];

  if (visiblePages.length === 0) {
    return <div className="text-muted-foreground">No settings available</div>;
  }

  return (
    <div className="flex flex-col gap-8 md:flex-row">
      {/* Sidebar navigation */}
      <nav className="w-full shrink-0 md:w-48">
        <ul className="flex flex-row gap-1 overflow-x-auto md:flex-col md:overflow-x-visible">
          {visiblePages.map((page) => (
            <li key={page.slug}>
              <Link
                href={`${basePath}?tab=${page.slug}`}
                className={cn(
                  "block whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
                  page.slug === activePage?.slug
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-gray-100 hover:text-foreground",
                )}
              >
                {page.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Content area */}
      <div className="min-w-0 flex-1">{activePage?.content}</div>
    </div>
  );
}
