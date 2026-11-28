"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";

type WorkspaceRow = {
  name: string;
  is_demo?: boolean;
  projects?: { id: string; name: string }[];
};

type Choice = { projectId: string; projectName: string; workspaceName: string };

// Step one of connecting an assistant: which project may it read? The choice is
// recorded for this sign-in, then the authorization carries on to the consent
// page. It is asked every time, so a user never grants a project they did not just
// pick.
export function SelectProjectClient() {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/workspaces")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("workspaces"))))
      .then(({ workspaces }: { workspaces: WorkspaceRow[] }) => {
        const list = workspaces
          .filter((w) => !w.is_demo)
          .flatMap((w) =>
            (w.projects ?? []).map((p) => ({
              projectId: p.id,
              projectName: p.name,
              workspaceName: w.name,
            })),
          );
        setChoices(list);
        if (list.length === 1) setSelected(list[0].projectId);
      })
      .catch(() => setError("Could not load your projects."));
  }, []);

  async function handleContinue() {
    if (!selected) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/oauth/select-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selected }),
      });
      if (!response.ok) throw new Error("select failed");
      const { data, error: continueError } = await authClient.oauth2.continue({
        postLogin: true,
      });
      if (continueError || !data?.url) throw new Error("continue failed");
      window.location.href = data.url;
    } catch {
      setError("Something went wrong. Go back to the assistant and try connecting again.");
      setPending(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-2 flex justify-center">
            <Logo />
          </div>
          <CardTitle className="text-lg font-semibold">Choose a project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-center text-[13px] text-muted-foreground">
            The assistant will be able to read this project&apos;s data, and no other project.
          </p>

          {choices === null && !error && (
            <div className="flex justify-center py-6 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {choices !== null && choices.length === 0 && (
            <p className="text-center text-[13px]">
              You do not have a project yet. Create one in TraceRoot, then connect again.
            </p>
          )}

          {choices !== null && choices.length > 0 && (
            <ul className="space-y-2" role="radiogroup" aria-label="Project">
              {choices.map((c) => (
                <li key={c.projectId}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected === c.projectId}
                    onClick={() => setSelected(c.projectId)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-[13px] ${
                      selected === c.projectId ? "border-foreground" : "border-border"
                    }`}
                  >
                    <span className="block font-medium">{c.projectName}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {c.workspaceName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="text-center text-[12px] text-red-500">{error}</p>}

          <Button className="w-full" disabled={!selected || pending} onClick={handleContinue}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Continue"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
