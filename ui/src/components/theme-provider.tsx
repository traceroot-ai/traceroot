"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

// Helper to get user-specific storage key
const getUserThemeKey = (): string => {
  if (typeof window === "undefined") return "theme";

  const userData = localStorage.getItem("user");
  if (userData) {
    try {
      const user = JSON.parse(userData);
      const userEmail = user?.email;
      if (userEmail) {
        return `theme-${userEmail}`;
      }
    } catch (e) {
      // If parsing fails, use default key
    }
  }
  return "theme";
};

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  const [storageKey, setStorageKey] = React.useState("theme");

  React.useEffect(() => {
    // Set user-specific storage key after mount
    const key = getUserThemeKey();
    setStorageKey(key);

    // Listen for user data changes
    const handleUserDataChange = () => {
      const newKey = getUserThemeKey();
      setStorageKey(newKey);
    };

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "user") {
        handleUserDataChange();
      }
    };

    window.addEventListener("userDataUpdated", handleUserDataChange);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("userDataUpdated", handleUserDataChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  return (
    <NextThemesProvider {...props} storageKey={storageKey}>
      {children}
    </NextThemesProvider>
  );
}
