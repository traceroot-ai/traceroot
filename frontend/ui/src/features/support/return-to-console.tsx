"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { exitImpersonation } from "./exit";

export function ReturnToConsole({ ended = false }: { ended?: boolean }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-lg space-y-4 p-8">
      <h1 className="text-xl font-semibold">
        {ended ? "This support session has ended" : "End the current support session?"}
      </h1>
      <p className="text-sm text-muted-foreground">
        {ended
          ? "Your access changed or the customer account is no longer available. Return to your employee account to continue."
          : "Return to your employee account before viewing another customer. The current session will be closed and logged."}
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await exitImpersonation(window.location.pathname + window.location.search);
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {ended ? "Back to my account" : "Exit and continue"}
      </Button>
    </div>
  );
}
