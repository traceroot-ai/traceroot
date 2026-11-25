"use client";

import { Check, ChevronDown, Earth } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ENABLED_LOCALES, localeInfo } from "@/lib/i18n/locales";
import { useLocale, useT } from "@/lib/i18n/provider";
import { storeLocale } from "@/lib/i18n/set-locale";

/**
 * A globe and the current language. The glyph is Earth, because the outline Globe already means
 * "environment" in DOMAIN_ICONS and one glyph should not stand for two things; the menu lists every enabled language by its own name, so
 * the list grows with the locale list and needs no layout change. The cookie is the choice;
 * refreshing the route re-renders the app in it. Shared by the account menu and the signed-out
 * screens, which have no account menu.
 */
export function LanguageToggle() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const current = localeInfo(locale);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${t("account.language")}: ${current.label}`}
          className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-border bg-background px-2 text-[12px] text-foreground transition-colors hover:bg-muted"
        >
          <Earth className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span lang={current.htmlLang}>{current.label}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        {ENABLED_LOCALES.map(({ code, label, htmlLang }) => (
          <DropdownMenuItem
            key={code}
            lang={htmlLang}
            aria-current={locale === code ? "true" : undefined}
            className="flex items-center justify-between gap-3 text-[13px]"
            onSelect={() => {
              if (locale === code) return;
              storeLocale(code);
              router.refresh();
            }}
          >
            {label}
            {locale === code && <Check className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
