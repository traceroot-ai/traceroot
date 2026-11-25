"use client";

import { useEffect } from "react";
import { useLayout } from "@/components/layout/app-layout";
import { ActiveSessions } from "@/features/settings/account";
import { SettingsLayout, ACCOUNT_SETTINGS_TABS } from "@/features/settings/settings-layout";
import { useT } from "@/lib/i18n/provider";

export default function AccountSessionsSettingsPage() {
  const { setHeaderContent } = useLayout();
  const t = useT();

  // Sessions are user-level, not workspace/project scoped, so there's no
  // WorkspaceBreadcrumb here — just a plain header label like other
  // top-level pages (e.g. Support).
  useEffect(() => {
    setHeaderContent(
      <span className="text-[13px] font-medium">{t("activeSessions.accountSettings")}</span>,
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent, t]);

  return (
    <div className="flex h-full">
      <SettingsLayout
        tabs={ACCOUNT_SETTINGS_TABS}
        activeTab="sessions"
        basePath="/account/settings"
      >
        <ActiveSessions />
      </SettingsLayout>
    </div>
  );
}
