import { useQuery } from "@tanstack/react-query";
import { fetchNextApi } from "@/lib/api/client";
import { useSession } from "@/lib/auth-client";

export function useDemoAccess() {
  const { data: session } = useSession();
  const userId = session?.user.id;
  return useQuery({
    queryKey: ["demo", userId],
    enabled: !!userId,
    queryFn: () =>
      fetchNextApi<{ available: boolean; joined: boolean; canLeave: boolean }>("/demo"),
  });
}
