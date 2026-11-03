"use client";

import { useEffect, useRef } from "react";
import { TURNSTILE_ORIGIN } from "@/lib/signup/captcha";

// Minimal Turnstile widget: loads the vendor script once and renders
// explicitly, so no extra dependency. The CSP admits the script through
// 'strict-dynamic' (it is inserted by already-trusted code) and the challenge
// frame through frame-src (see lib/csp.ts).

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;
let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    // Either failure clears the cache so a later mount can retry the load.
    const fail = (message: string) => {
      scriptPromise = null;
      reject(new Error(message));
    };
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : fail("turnstile missing");
    script.onerror = () => fail("turnstile failed to load");
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function Turnstile({
  siteKey,
  onToken,
  onError,
  resetKey,
}: {
  siteKey: string;
  // Called with a fresh token, or null when it expires.
  onToken: (token: string | null) => void;
  // The script failed to load or the challenge errored; no token is coming.
  onError: () => void;
  // Change it to get a new token: each one is single-use.
  resetKey: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId.current = turnstile.render(container.current, {
          sitekey: siteKey,
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => {
            onTokenRef.current(null);
            onErrorRef.current();
          },
        });
      })
      .catch(() => {
        onTokenRef.current(null);
        onErrorRef.current();
      });
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || !widgetId.current) return;
    window.turnstile?.reset(widgetId.current);
  }, [resetKey]);

  return <div ref={container} className="flex justify-center" />;
}
