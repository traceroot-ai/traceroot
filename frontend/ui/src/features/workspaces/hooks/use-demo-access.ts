import { useQuery } from "@tanstack/react-query";
import { fetchNextApi } from "@/lib/api/client";

export function useDemoAccess() {
  return useQuery({
    queryKey: ["demo"],
    queryFn: () =>
      fetchNextApi<{ available: boolean; joined: boolean; canLeave: boolean }>("/demo"),
  });
}
