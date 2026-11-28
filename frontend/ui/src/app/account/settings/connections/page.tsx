"use client";

import { useEffect } from "react";
import { useLayout } from "@/components/layout/app-layout";
import { ConnectedAssistants } from "@/features/settings/account";
import { SettingsLayout, ACCOUNT_SETTINGS_TABS } from "@/features/settings/settings-layout";

export default function AccountConnectionsSettingsPage() {
  const { setHeaderContent } = useLayout();

  useEffect(() => {
    setHeaderContent(<span className="text-[13px] font-medium">Account Settings</span>);
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  return (
    <div className="flex h-full">
      <SettingsLayout
        tabs={ACCOUNT_SETTINGS_TABS}
        activeTab="connections"
        basePath="/account/settings"
      >
        <ConnectedAssistants />
      </SettingsLayout>
    </div>
  );
}
