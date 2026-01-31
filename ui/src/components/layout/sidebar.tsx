"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/organizations", label: "Organizations", icon: Building2 },
];

export function Sidebar() {
  const pathname = usePathname();

  // Don't show sidebar on auth pages
  if (pathname.startsWith("/auth/")) {
    return null;
  }

  return (
    <div className="flex h-screen w-64 flex-col border-r bg-gray-50">
      {/* Logo */}
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Image
            src="/images/traceroot_logo.png"
            alt="Traceroot Logo"
            width={120}
            height={32}
            className="h-8 w-auto"
          />
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-4">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              pathname === item.href || pathname.startsWith(item.href + "/")
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-gray-100 hover:text-foreground",
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
