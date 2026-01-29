"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Building2, LogOut } from "lucide-react";                                                                                                                                                                            
import { cn } from "@/lib/utils";                                                                                                                                                                                                          
                                                                                                                                                                                                                                           
const navItems = [                                                                                                                                                                                                                         
  { href: "/organizations", label: "Organizations", icon: Building2 },                                                                                                                                                                     
];                                                                                                                                                                                                                                         
                                                                                                                                                                                                                                           
export function Sidebar() {                                                                                                                                                                                                                
  const pathname = usePathname();                                                                                                                                                                                                          
  const { data: session, status } = useSession();                                                                                                                                                                                               
                                                                                                                                                                                                                                           
  // Don't show sidebar on auth pages                                                                                                                                                                                                      
  if (pathname.startsWith("/auth/")) {                                                                                                                                                                                                     
    return null;                                                                                                                                                                                                                           
  }                                                                                                                                                                                                                                        
                                                                                                                                                                                                                                           
  return (
    <div className="flex h-screen w-56 flex-col border-r bg-white">
      {/* Logo */}
      <div className="flex h-12 items-center border-b px-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Image
            src="/images/traceroot_logo.png"
            alt="Traceroot Logo"
            width={100}
            height={28}
            className="h-7 w-auto"
          />
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 p-3">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              pathname === item.href || pathname.startsWith(item.href + "/")
                ? "bg-gray-100 text-foreground font-medium"
                : "text-muted-foreground hover:bg-gray-50 hover:text-foreground"
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      </nav>

      {/* User section */}
      <div className="border-t p-3">
        <div className="mb-2 w-full text-xs text-muted-foreground truncate">
          {session?.user?.email}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full h-8 text-xs"
          onClick={() => signOut({ callbackUrl: "/auth/sign-in" })}
        >
          <LogOut className="mr-1.5 h-3.5 w-3.5" />
          Sign out
        </Button>
      </div>
    </div>                                                                                                                                                                                                                                 
  );                                                                                                                                                                                                                                       
}                                                                        