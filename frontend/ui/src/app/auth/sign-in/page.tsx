import { env } from "@/env";
import { configuredSocialProviders } from "@/lib/social-providers";
import { clientIdFromCallbackUrl } from "@/lib/oauth/client-display";
import { loadOAuthClientDisplay } from "@/lib/oauth/load-client-display";
import { SignInClient } from "./sign-in-client";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  // A sign-in on the way to connecting an assistant says which one.
  const { callbackUrl } = await searchParams;
  const connection = await loadOAuthClientDisplay(
    clientIdFromCallbackUrl(typeof callbackUrl === "string" ? callbackUrl : null),
  );

  return (
    <SignInClient socialProviders={configuredSocialProviders(env)} connection={connection} />
  );
}
