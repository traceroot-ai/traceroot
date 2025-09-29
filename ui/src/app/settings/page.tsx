"use client";

import React from "react";
import { SettingsContainer } from "@/components/settings/SettingsContainer";

/**
 * Settings page - now uses unified SettingsContainer that handles both local and production modes.
 */
export default function SettingsPage() {
  return <SettingsContainer />;
}
