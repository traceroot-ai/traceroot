"use client";

import { createAuthClient } from "better-auth/react";
import { adminClient, deviceAuthorizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  plugins: [adminClient(), deviceAuthorizationClient()],
});

export const { useSession, signIn, signOut, signUp } = authClient;
