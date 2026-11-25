"use client";

import { Github, BookOpen, MessageCircle, Calendar, ArrowUpRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { clientEnv } from "@/env.client";
import { useT } from "@/lib/i18n/provider";
import type { MessageKey } from "@/lib/i18n/messages/en";

const supportChannels: {
  id: string;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  icon: typeof BookOpen;
  href: string;
  external: boolean;
}[] = [
  {
    id: "documentation",
    titleKey: "support.documentation",
    descriptionKey: "support.documentationText",
    icon: BookOpen,
    href: clientEnv.NEXT_PUBLIC_DOCS_URL,
    external: true,
  },
  {
    id: "github-issues",
    titleKey: "support.githubIssues",
    descriptionKey: "support.githubIssuesText",
    icon: Github,
    href: clientEnv.NEXT_PUBLIC_GITHUB_ISSUES_URL,
    external: true,
  },
  {
    id: "discord",
    titleKey: "support.discord",
    descriptionKey: "support.discordText",
    icon: MessageCircle,
    href: clientEnv.NEXT_PUBLIC_DISCORD_INVITE_URL,
    external: true,
  },
  {
    id: "contact-founders",
    titleKey: "support.contactFounders",
    descriptionKey: "support.contactFoundersText",
    icon: Calendar,
    href: clientEnv.NEXT_PUBLIC_FOUNDERS_CAL_URL,
    external: true,
  },
];

export default function SupportPage() {
  const t = useT();
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <PageHeader title={t("support.title")} />
      <div className="min-w-0 flex-1 overflow-auto">
        <table className="data-table w-full min-w-[32rem]">
          <thead>
            <tr>
              <th className="w-[16rem] whitespace-nowrap px-3 text-left">
                {t("support.colChannel")}
              </th>
              <th className="whitespace-nowrap px-3 text-left">{t("support.colDescription")}</th>
              <th className="w-[56px] px-2" aria-label={t("support.open")} />
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
                      {t(channel.titleKey)}
                    </a>
                  </td>
                  <td className="whitespace-nowrap px-3 text-muted-foreground">
                    {t(channel.descriptionKey)}
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
