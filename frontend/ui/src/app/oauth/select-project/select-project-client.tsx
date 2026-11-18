"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ConnectFrame } from "@/features/oauth-connect";
import { CONTINUE_PATH, type OAuthClientDisplay } from "@/lib/oauth/client-display";

type WorkspaceRow = {
  id: string;
  name: string;
  role?: string;
  is_demo?: boolean;
  projects?: { id: string; name: string }[];
};

type WorkspaceGroup = {
  id: string;
  name: string;
  canCreate: boolean;
  projects: { id: string; name: string }[];
};

// Past this many projects the list gets a search box.
export const SEARCH_THRESHOLD = 6;

function toGroups(workspaces: WorkspaceRow[]): WorkspaceGroup[] {
  return workspaces
    .filter((w) => !w.is_demo)
    .map((w) => ({
      id: w.id,
      name: w.name,
      canCreate: w.role !== "VIEWER",
      projects: [...(w.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

// Step one of connecting an assistant: which project may it read? The choice is
// recorded for this sign-in, then the authorization carries on to the consent
// page. It is asked every time, so a user never grants a project they did not just
// pick.
export function SelectProjectClient({ client = null }: { client?: OAuthClientDisplay | null }) {
  const [groups, setGroups] = useState<WorkspaceGroup[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assistant = client?.name ?? "The assistant";

  async function loadProjects(select?: string) {
    try {
      const response = await fetch("/api/workspaces");
      if (!response.ok) throw new Error("workspaces");
      const { workspaces }: { workspaces: WorkspaceRow[] } = await response.json();
      const next = toGroups(workspaces);
      setGroups(next);
      const all = next.flatMap((g) => g.projects);
      if (select) setSelected(select);
      else if (all.length === 1) setSelected(all[0].id);
    } catch {
      setError("Could not load your projects.");
    }
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  const total = groups?.reduce((n, g) => n + g.projects.length, 0) ?? 0;
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!groups || !needle) return groups;
    return groups
      .map((g) => ({
        ...g,
        projects: g.projects.filter(
          (p) => p.name.toLowerCase().includes(needle) || g.name.toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.projects.length > 0);
  }, [groups, filter]);

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
    <ConnectFrame client={client} title={`Choose a project for ${assistant}`}>
      <div className="space-y-4">
        <p className="text-[13px] text-muted-foreground">
          {assistant} will be able to read this project&apos;s data, and no other project.
          You&apos;ll review exactly what it can see next.
        </p>

        {groups === null && !error && (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading projects" />
          </div>
        )}

        {groups !== null && total === 0 && (
          <EmptyState groups={groups} onCreated={(id) => loadProjects(id)} />
        )}

        {groups !== null && total > SEARCH_THRESHOLD && (
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="h-8 pl-8 text-[13px]"
            />
          </div>
        )}

        {visible && total > 0 && (
          <div
            role="radiogroup"
            aria-label="Project"
            className="max-h-[320px] space-y-3 overflow-y-auto"
          >
            {visible.length === 0 && (
              <p className="py-3 text-center text-[13px] text-muted-foreground">
                No project matches &ldquo;{filter}&rdquo;.
              </p>
            )}
            {visible.map((group) => (
              <section key={group.id} aria-label={group.name}>
                <h2 className="mb-1.5 text-[12px] font-medium text-muted-foreground">
                  {group.name}
                </h2>
                <ul className="space-y-1.5">
                  {group.projects.map((p) => {
                    const checked = selected === p.id;
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          onClick={() => setSelected(p.id)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                            checked
                              ? "border-foreground/70 bg-muted"
                              : "border-border hover:bg-muted/50",
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                              checked ? "border-foreground" : "border-muted-foreground/50",
                            )}
                          >
                            {checked && <span className="h-2 w-2 rounded-full bg-foreground" />}
                          </span>
                          <span className="truncate font-medium">{p.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {error && <p className="text-center text-[12px] text-red-500">{error}</p>}

        {total > 0 && (
          <Button className="w-full" disabled={!selected || pending} onClick={handleContinue}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Continue"}
          </Button>
        )}
      </div>
    </ConnectFrame>
  );
}

// No project yet. With a workspace to put one in, create it here and pick it;
// with none, set one up through onboarding, which returns to this authorization.
function EmptyState({
  groups,
  onCreated,
}: {
  groups: WorkspaceGroup[];
  onCreated: (projectId: string) => void;
}) {
  const workspace = groups.find((g) => g.canCreate) ?? null;
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workspace) {
    const restart = `${CONTINUE_PATH}${typeof window === "undefined" ? "" : window.location.search}`;
    return (
      <div className="rounded-md border border-dashed px-4 py-5 text-center">
        <p className="text-[13px] font-medium">You don&apos;t have a project yet</p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Set one up, and you&apos;ll come straight back here to finish connecting.
        </p>
        <a
          href={`/onboarding?callbackUrl=${encodeURIComponent(restart)}`}
          className={cn(buttonVariants({ size: "sm" }), "mt-3")}
        >
          Set up a project
        </a>
      </div>
    );
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!workspace || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not create the project.");
      onCreated(body.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the project.");
      setCreating(false);
    }
  }

  return (
    <form onSubmit={create} className="rounded-md border border-dashed px-4 py-4">
      <p className="text-[13px] font-medium">You don&apos;t have a project yet</p>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Create one in {workspace.name} to connect. It starts empty; send traces to it any time.
      </p>
      <div className="mt-3 flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          aria-label="Project name"
          className="h-8 text-[13px]"
          maxLength={100}
        />
        <Button type="submit" size="sm" disabled={!name.trim() || creating}>
          {creating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Plus className="mr-1 h-3.5 w-3.5" /> Create
            </>
          )}
        </Button>
      </div>
      {error && <p className="mt-2 text-[12px] text-red-500">{error}</p>}
    </form>
  );
}
