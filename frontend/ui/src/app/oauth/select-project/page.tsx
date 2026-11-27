import { Suspense } from "react";
import { loadOAuthClientDisplay } from "@/lib/oauth/load-client-display";
import { SelectProjectClient } from "./select-project-client";

export const dynamic = "force-dynamic";

export default async function OAuthSelectProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ client_id?: string | string[] }>;
}) {
  const { client_id: clientId } = await searchParams;
  const client = await loadOAuthClientDisplay(typeof clientId === "string" ? clientId : null);
  return (
    <Suspense fallback={null}>
      <SelectProjectClient client={client} />
    </Suspense>
  );
}
