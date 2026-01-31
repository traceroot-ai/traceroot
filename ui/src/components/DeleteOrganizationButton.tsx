"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteOrganization } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";

interface DeleteOrganizationButtonProps {
  orgId: string;
  orgName: string;
}

export function DeleteOrganizationButton({
  orgId,
  orgName,
}: DeleteOrganizationButtonProps) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => deleteOrganization(orgId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.removeQueries({ queryKey: ["organization", orgId] });
      setOpen(false);
      router.push("/organizations");
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const canDelete = confirmText === orgName;

  const handleClose = () => {
    setOpen(false);
    setConfirmText("");
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}
    >
      <DialogTrigger asChild>
        <Button variant="destructive">Delete Organization</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Delete Organization
          </DialogTitle>
          <DialogDescription>
            This action cannot be undone. All projects, API keys, members, and
            data associated with this organization will be permanently deleted.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p className="mb-3 text-sm">
            Type <strong className="select-all">{orgName}</strong> to confirm:
          </p>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="Organization name"
            autoComplete="off"
          />
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canDelete || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Deleting..." : "Delete Organization"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
