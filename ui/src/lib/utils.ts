import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function truncateTitle(title: string, maxLength: number = 10): string {
  if (title.length <= maxLength) {
    return title;
  }
  return title.substring(0, maxLength) + "...";
}
