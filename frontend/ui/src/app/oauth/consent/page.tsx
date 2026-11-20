import { Suspense } from "react";
import { getRequestSession } from "@/lib/request-session";
import { loadOAuthClientDisplay } from "@/lib/oauth/load-client-display";
import { ConsentClient } from "./consent-client";

export const dynamic = "force-dynamic";

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ client_id?: string | string[] }>;
}) {
  const { client_id: clientId } = await searchParams;
  const [client, session] = await Promise.all([
    loadOAuthClientDisplay(typeof clientId === "string" ? clientId : null),
    getRequestSession(),
  ]);
  return (
    <Suspense fallback={null}>
      <ConsentClient client={client} accountEmail={session?.user?.email ?? null} />
    </Suspense>
  );
}
