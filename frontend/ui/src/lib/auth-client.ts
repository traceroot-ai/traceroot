"use client";

import { createAuthClient } from "better-auth/react";
import { adminClient, deviceAuthorizationClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  plugins: [adminClient(), deviceAuthorizationClient(), oauthProviderClient()],
});

export const { useSession, signIn, signOut, signUp } = authClient;
