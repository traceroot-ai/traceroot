"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLayout } from "@/components/layout/app-layout";
import { cn } from "@/lib/utils";
import { isStaff } from "@/lib/support/policy";
import { SUPPORT_ACTIVE_KEY, SUPPORT_RETURN_KEY } from "./exit";

type User = {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  banned?: boolean;
  emailVerified?: boolean;
};
type View = "users" | "staff";
type StaffRole = "admin" | "support" | null;
const PAGE_SIZE = 25;

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message ?? data.error ?? data.message ?? "Request failed");
  return data;
}
const post = (url: string, body: unknown) =>
  api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function impersonateBlocker(user: User) {
  if (isStaff(user.role)) return "Staff accounts cannot be impersonated";
  if (user.banned) return "Banned accounts cannot be impersonated";
  return null;
}

export function SupportConsole({ role, actorId }: { role: "admin" | "support"; actorId: string }) {
  const search = useSearchParams();
  const { setHeaderContent } = useLayout();
  const [view, setView] = useState<View>("users");
  const [q, setQ] = useState(search.get("q") ?? search.get("userId") ?? "");
  const [page, setPage] = useState(Math.max(1, Number(search.get("page")) || 1));
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [target, setTarget] = useState<User | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ user: User; role: StaffRole } | null>(null);
  const [deepLinked, setDeepLinked] = useState(false);
  useEffect(() => {
    setHeaderContent(<span className="font-medium">Support console</span>);
    return () => setHeaderContent(null);
  }, [setHeaderContent]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError("");
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ view, q: q.trim(), page: String(page) });
      api(`/api/support?${params}`, { signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return;
          const nextTotal = data.total ?? data.rows.length;
          if (view === "users" && nextTotal > 0 && page > Math.ceil(nextTotal / PAGE_SIZE)) {
            setPage(Math.ceil(nextTotal / PAGE_SIZE));
            return;
          }
          setUsers(data.rows);
          setTotal(nextTotal);
          if (!deepLinked && view === "users" && search.get("userId")) {
            const user = data.rows.find((u: User) => u.id === search.get("userId"));
            if (user && !impersonateBlocker(user)) setTarget(user);
            setDeepLinked(true);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setListError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [view, q, page, refresh, search, deepLinked]);
  function switchView(next: string) {
    setView(next as View);
    setUsers([]);
    setTotal(0);
    setPage(1);
    setQ("");
    setListError("");
    setActionError("");
  }
  async function start() {
    setBusy(true);
    setActionError("");
    try {
      await post("/api/auth/support/start", { userId: target!.id, reason });
      sessionStorage.setItem(
        SUPPORT_RETURN_KEY,
        `/admin?${new URLSearchParams({ q, page: String(page) })}`,
      );
      sessionStorage.setItem(SUPPORT_ACTIVE_KEY, "true");
      window.location.assign("/");
    } catch (e) {
      setActionError((e as Error).message);
      setBusy(false);
    }
  }
  async function grant() {
    setBusy(true);
    setActionError("");
    try {
      await post("/api/support", { email: confirmation!.user.email, role: confirmation!.role });
      setConfirmation(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Support console</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find a customer and impersonate their account. All support access is logged.
        </p>
      </div>
      {role === "admin" && (
        <Tabs value={view} onValueChange={switchView}>
          <TabsList aria-label="Support console">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="staff">Staff access</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {listError && (
        <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-600">
          {listError}
        </p>
      )}
      {view === "users" && (
        <Input
          aria-label="Search users"
          placeholder="Filter by email or exact user ID"
          className="max-w-sm"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      )}
      <div
        className={cn(
          "max-w-5xl overflow-x-auto rounded-lg border transition-opacity",
          loading && "opacity-60",
        )}
        aria-busy={loading}
      >
        <table className="w-full min-w-[760px] table-fixed text-left text-sm">
          <colgroup>
            <col className="w-44" />
            <col className="w-64" />
            <col />
            <col className={view === "staff" ? "w-40" : "w-36"} />
          </colgroup>
          <thead className="border-b bg-muted/40">
            <tr>
              <th className="p-3 font-medium">Name</th>
              <th className="p-3 font-medium">Email</th>
              <th className="p-3 font-medium">User ID</th>
              <th className="p-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const blocker = view === "users" ? impersonateBlocker(user) : null;
              const self = user.id === actorId;
              const eligible = !!user.emailVerified && !user.banned;
              return (
                <tr key={user.id} className="border-b last:border-0">
                  <td className="truncate p-3 font-medium" title={user.name ?? undefined}>
                    {user.name || "—"}
                  </td>
                  <td className="truncate p-3 text-muted-foreground" title={user.email}>
                    {user.email}
                  </td>
                  <td
                    className="truncate p-3 font-mono text-xs text-muted-foreground"
                    title={user.id}
                  >
                    {user.id}
                  </td>
                  <td className="p-3 text-right">
                    {view === "staff" ? (
                      <Select
                        value={isStaff(user.role) ? user.role : "none"}
                        disabled={busy || self || (!eligible && !isStaff(user.role))}
                        onValueChange={(value) => {
                          setActionError("");
                          setConfirmation({
                            user,
                            role: value === "none" ? null : (value as Exclude<StaffRole, null>),
                          });
                        }}
                      >
                        <SelectTrigger
                          className="ml-auto h-8 w-32 text-xs"
                          aria-label={`Staff access for ${user.email}`}
                          title={
                            self
                              ? "You cannot change your own role"
                              : !eligible && !isStaff(user.role)
                                ? "Only verified, non-banned accounts can be granted access"
                                : undefined
                          }
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                          <SelectItem value="admin" disabled={!eligible}>
                            Admin
                          </SelectItem>
                          <SelectItem value="support" disabled={!eligible}>
                            Support
                          </SelectItem>
                          <SelectItem value="none">No Access</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span title={blocker ?? undefined}>
                        <Button
                          variant="outline"
                          disabled={!!blocker}
                          onClick={() => {
                            setTarget(user);
                            setReason("");
                            setActionError("");
                          }}
                        >
                          Impersonate
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {users.length === 0 && (
          <p className="p-8 text-center text-muted-foreground" role="status">
            {loading ? "Loading…" : `No ${view === "staff" ? "staff accounts" : "users"} found.`}
          </p>
        )}
      </div>
      {view === "users" && (
        <div className="flex max-w-5xl items-center justify-between text-sm text-muted-foreground">
          <span>
            {total} results · Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={loading || page <= 1}
              onClick={() => setPage((n) => n - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={loading || page >= pages}
              onClick={() => setPage((n) => n + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !busy) setTarget(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Impersonate {target?.name || target?.email}</DialogTitle>
          <DialogDescription className="sr-only">{target?.email}</DialogDescription>
          <label className="space-y-2 text-sm">
            Reason (optional)
            <textarea
              className="w-full rounded-md border bg-background p-3"
              rows={2}
              placeholder="Ticket number or what you are checking"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {actionError && (
            <p role="alert" className="text-sm text-red-600">
              {actionError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={start}>
              {busy ? "Starting…" : "Start session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {confirmation?.role ? `Grant ${confirmation.role} access?` : "Revoke staff access?"}
          </DialogTitle>
          <DialogDescription>
            {confirmation?.user.email}.{" "}
            {confirmation?.role === "admin"
              ? "Admins can write as customers and manage employee access."
              : confirmation?.role === "support"
                ? "Support can view customers in read-only mode."
                : "Active impersonation access will end immediately."}{" "}
            This change is audited.
          </DialogDescription>
          {actionError && (
            <p role="alert" className="text-sm text-red-600">
              {actionError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={grant}>
              {busy ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
