"use client";

import { useRouter } from "next/navigation";
import { ENABLED_LOCALES } from "@/lib/i18n/locales";
import { useLocale, useT } from "@/lib/i18n/provider";
import { storeLocale } from "@/lib/i18n/set-locale";
import { cn } from "@/lib/utils";

/**
 * One button per enabled language. The cookie is the choice; refreshing the route re-renders the
 * app in it. Shared by the account menu and the signed-out screens, which have no account menu.
 */
export function LanguageToggle() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  return (
    <div className="btn-group" role="radiogroup" aria-label={t("account.language")}>
      {ENABLED_LOCALES.map(({ code, short, label, htmlLang }) => (
        <button
          key={code}
          type="button"
          role="radio"
          aria-checked={locale === code}
          aria-label={label}
          title={label}
          lang={htmlLang}
          onClick={() => {
            if (locale === code) return;
            storeLocale(code);
            router.refresh();
          }}
          className={cn(
            "inline-flex h-6 items-center justify-center px-2 text-[12px] transition-colors",
            locale === code
              ? "!bg-accent text-foreground"
              : "text-muted-foreground hover:!bg-muted hover:text-foreground",
          )}
        >
          {short}
        </button>
      ))}
    </div>
  );
}
