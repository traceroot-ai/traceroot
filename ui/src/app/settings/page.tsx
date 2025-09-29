"use client";

import React from "react";
import { LocalSettingsContainer } from "@/components/settings/LocalSettingsContainer";
import { SettingsContainer } from "@/components/settings/SettingsContainer";

const DISABLE_PAYMENT = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

/**
 * Wrapper: choose Local mock (no Autumn) vs Prod (Autumn).
 */
export default function SettingsPage() {
  return DISABLE_PAYMENT ? <LocalSettingsContainer /> : <SettingsContainer />;
}
