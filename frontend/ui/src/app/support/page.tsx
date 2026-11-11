"use client";

import { Github, BookOpen, MessageCircle, Calendar, ArrowUpRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { clientEnv } from "@/env.client";

const supportChannels = [
  {
    id: "documentation",
    title: "Documentation",
    description: "Tutorials and guides to get started.",
    icon: BookOpen,
    href: clientEnv.NEXT_PUBLIC_DOCS_URL,
    external: true,
  },
  {
    id: "github-issues",
    title: "GitHub Issues",
    description: "Report bugs or request new features.",
    icon: Github,
    href: clientEnv.NEXT_PUBLIC_GITHUB_ISSUES_URL,
    external: true,
  },
  {
    id: "discord",
    title: "Discord",
    description: "Chat with the community and team.",
    icon: MessageCircle,
    href: clientEnv.NEXT_PUBLIC_DISCORD_INVITE_URL,
    external: true,
  },
  {
    id: "contact-founders",
    title: "Contact Founders",
    description: "Book a call with the founding team.",
    icon: Calendar,
    href: clientEnv.NEXT_PUBLIC_FOUNDERS_CAL_URL,
    external: true,
  },
];

export default function SupportPage() {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <PageHeader title="Support" />
      <div className="min-w-0 flex-1 overflow-auto">
        <table className="data-table w-full min-w-[32rem]">
          <thead>
            <tr>
              <th className="w-[16rem] whitespace-nowrap px-3 text-left">Channel</th>
              <th className="whitespace-nowrap px-3 text-left">Description</th>
              <th className="w-[56px] px-2" aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {supportChannels.map((channel) => {
              const Icon = channel.icon;
              return (
                <tr
                  key={channel.id}
                  onClick={() => window.open(channel.href, "_blank", "noopener,noreferrer")}
                  className="cursor-pointer transition-colors hover:bg-muted"
                >
                  <td className="whitespace-nowrap px-3 text-foreground">
                    <a
                      href={channel.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-2"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {channel.title}
                    </a>
                  </td>
                  <td className="whitespace-nowrap px-3 text-muted-foreground">
                    {channel.description}
                  </td>
                  <td className="px-2 text-right">
                    <ArrowUpRight className="inline h-3.5 w-3.5 text-muted-foreground" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
