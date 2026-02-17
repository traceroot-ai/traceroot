"use client";

import {
  FaGithub,
  FaShieldAlt,
  FaUserShield,
  FaExclamationTriangle,
} from "react-icons/fa";
import TraceRootLogo from "@/components/TraceRootLogo";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface GitHubOAuthModalProps {
  open: boolean;
  onClose: () => void;
}

const permissions = [
  {
    icon: <FaShieldAlt className="text-foreground mt-0.5 shrink-0" size={14} />,
    title: "Permissions always respected",
    description:
      "TraceRoot is strictly limited to permissions you've explicitly set. Disconnect access anytime to revoke permissions.",
  },
  {
    icon: (
      <FaUserShield className="text-foreground mt-0.5 shrink-0" size={14} />
    ),
    title: "You're in control",
    description:
      "Data from GitHub is used only to provide relevant debugging context. Your repositories are never stored or trained on.",
  },
  {
    icon: (
      <FaExclamationTriangle
        className="text-foreground mt-0.5 shrink-0"
        size={14}
      />
    ),
    title: "Connectors may introduce risk",
    description:
      "Connectors are designed to respect your privacy, but only grant access to repositories you intend to share with TraceRoot.",
  },
];

export default function GitHubOAuthModal({
  open,
  onClose,
}: GitHubOAuthModalProps) {
  const handleConnect = () => {
    window.location.href = "/api/auth/github/start";
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md font-mono">
        <DialogHeader className="items-center space-y-3 pt-2">
          <div className="flex items-center gap-3">
            <TraceRootLogo size={20} />
            <div className="flex gap-1">
              <span className="size-1.5 rounded-full bg-muted-foreground/40" />
              <span className="size-1.5 rounded-full bg-muted-foreground/40" />
              <span className="size-1.5 rounded-full bg-muted-foreground/40" />
            </div>
            <div className="flex items-center justify-center size-10 rounded-lg bg-muted">
              <FaGithub size={20} className="text-foreground" />
            </div>
          </div>
          <DialogTitle className="text-lg font-semibold">
            Connect GitHub
          </DialogTitle>
          <DialogDescription className="text-center text-sm text-muted-foreground">
            Allow TraceRoot to access your GitHub repositories for code context
            and automated actions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-0 rounded-lg border overflow-hidden">
          {permissions.map((item, index) => (
            <div key={index}>
              <div className="flex gap-3 p-4">
                {item.icon}
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {item.description}
                  </p>
                </div>
              </div>
              {index < permissions.length - 1 && <Separator />}
            </div>
          ))}
        </div>

        <Button onClick={handleConnect} className="w-full" size="sm">
          <FaGithub size={14} />
          Continue to GitHub
        </Button>
      </DialogContent>
    </Dialog>
  );
}
