import { Suspense } from "react";
import { ConsentClient } from "./consent-client";

export const dynamic = "force-dynamic";

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={null}>
      <ConsentClient />
    </Suspense>
  );
}
