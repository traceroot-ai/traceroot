import { Suspense } from "react";
import { SelectProjectClient } from "./select-project-client";

export const dynamic = "force-dynamic";

export default function OAuthSelectProjectPage() {
  return (
    <Suspense fallback={null}>
      <SelectProjectClient />
    </Suspense>
  );
}
