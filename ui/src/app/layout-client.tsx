"use client";

import { usePathname } from "next/navigation";
import AuthenticatedLayout from "./authenticated-layout";

export default function RootLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Routes that should not have sidebar or Autumn provider
  const noLayoutRoutes = ["/sign-in", "/sign-up", "/login"];
  const isPublicRoute = noLayoutRoutes.some((route) =>
    pathname.startsWith(route),
  );

  // Always render AuthenticatedLayout to maintain consistent component tree
  // Pass isPublicRoute to conditionally apply guards/providers internally
  return (
    <AuthenticatedLayout isPublicRoute={isPublicRoute}>
      {children}
    </AuthenticatedLayout>
  );
}
