import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { supportRequest } from "@/lib/support/request-context";

// A null session is also a resolved result. Never cache across requests.
export async function getRequestSession() {
  const context = supportRequest.getStore();
  if (context) return context.session;
  return auth.api.getSession({ headers: await headers() });
}
