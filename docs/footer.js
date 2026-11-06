/**
 * Small adapter for Mintlify's documented #footer and mintlify:navigate hooks.
 * Native children remain in place and visible until enhancement succeeds.
 * No framework runtime, body observer, analytics SDK, or remote HTML is loaded.
 */
(() => {
  const previous = window.__trDocsFooterAdapter;
  if (previous && typeof previous.dispose === "function") previous.dispose();

  const consentKey = "traceroot-analytics-consent";
  const consentRetryDelaysMs = [100, 200, 400, 800, 1600, 3200, 3200];
  // Public visitor-project token from docs.json. Verify it before controlling
  // window.posthog: Mintlify's own analytics must never be mistaken for ours.
  const visitorToken = "phc_X8eeQUsyMb7bk5sw0msmN8ARBxurlVyQxC0uvHVul7C";
  const localPreview = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const globalEvents = new AbortController();
  let mounted = null;
  let timer = 0;
  let consentTimer = 0;
  let generation = 0;
  let visitChoice;

  function storedChoice() {
    if (visitChoice) return visitChoice;
    try {
      const value = localStorage.getItem(consentKey);
      return value === "allowed" || value === "denied" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function visitorAnalytics() {
    const sdk = window.posthog;
    try {
      return sdk &&
        typeof sdk.get_config === "function" &&
        sdk.get_config("token") === visitorToken &&
        typeof sdk.has_opted_out_capturing === "function" &&
        typeof sdk.opt_out_capturing === "function" &&
        typeof sdk.opt_in_capturing === "function"
        ? sdk
        : null;
    } catch {
      return null;
    }
  }

  function applyChoice(sdk, choice) {
    if (!sdk || !choice) return;
    const optedOut = sdk.has_opted_out_capturing();
    // Reapplying an allowed preference on every navigation can emit another
    // PostHog opt-in event. Only transition when the SDK's state differs.
    if (choice === "denied" && !optedOut) sdk.opt_out_capturing();
    else if (choice === "allowed" && optedOut) sdk.opt_in_capturing();
  }

  function syncStoredChoice() {
    window.clearTimeout(consentTimer);
    let attempt = 0;
    const sync = () => {
      consentTimer = 0;
      if (globalEvents.signal.aborted) return;
      const choice = storedChoice();
      if (!choice) return;
      try {
        const sdk = visitorAnalytics();
        if (sdk) {
          applyChoice(sdk, choice);
          return;
        }
      } catch { /* A late SDK may not be fully initialized yet. */ }
      // Bound readiness probes; never replace the SDK's initialization policy.
      const delay = consentRetryDelaysMs[attempt++];
      if (delay !== undefined) consentTimer = window.setTimeout(sync, delay);
    };
    sync();
  }

  function cleanMount() {
    if (!mounted) return;
    mounted.wordmarkDispose?.();
    mounted.events.abort();
    if (mounted.dialog.open) mounted.dialog.close();
    mounted.node.remove();
    mounted.host.removeAttribute("data-tr-footer-ready");
    mounted = null;
  }

  const externalIcon = '<svg class="tr-docs-footer__external" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><path d="M2.5 7.5l5-5M3.5 2.5h4v4"/></svg>';
  const xIcon = '<svg class="tr-docs-footer__social" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';

  function footerMarkup(assets) {
    // The supported production subpath is /docs; local Mint previews have no
    // prefix. Keep cross-site links absolute so Mintlify cannot prefix them.
    return `
      <div class="tr-docs-footer__columns">
        <div class="tr-docs-footer__brand">
          <a class="tr-docs-footer__logo" href="https://traceroot.ai/" aria-label="TraceRoot home">
            <img src="${assets}mark.svg" width="21" height="21" alt=""><span>traceroot</span>
          </a>
          <p class="tr-docs-footer__description">Open source AI agent improvement platform.</p>
          <p class="tr-docs-footer__eyebrow tr-docs-footer__location">San Francisco</p>
        </div>
        <nav aria-label="Product">
          <h2 class="tr-docs-footer__eyebrow">Product</h2>
          <div class="tr-docs-footer__links">
            <a href="https://traceroot.ai/docs">Docs ${externalIcon}</a>
            <a href="https://traceroot.ai/#pricing">Pricing</a>
            <a href="https://traceroot.ai/changelog">Changelog</a>
            <a href="https://app.traceroot.ai/">App</a>
            <a href="https://traceroot.ai/security">Security</a>
          </div>
        </nav>
        <nav aria-label="Company">
          <h2 class="tr-docs-footer__eyebrow">Company</h2>
          <div class="tr-docs-footer__links">
            <a href="https://traceroot.ai/blog">Blog</a>
            <a href="https://traceroot.ai/service">Service description</a>
            <a href="https://cal.com/traceroot/30min" target="_blank" rel="noopener noreferrer">Talk to sales ${externalIcon}</a>
          </div>
        </nav>
        <nav aria-label="Connect">
          <h2 class="tr-docs-footer__eyebrow">Connect</h2>
          <div class="tr-docs-footer__links">
            <a href="https://x.com/TracerootAI" target="_blank" rel="noopener noreferrer">${xIcon}X</a>
            <a href="https://github.com/traceroot-ai/traceroot" target="_blank" rel="noopener noreferrer"><img class="tr-docs-footer__social" src="${assets}github.svg" width="13" height="13" alt="">GitHub</a>
            <a href="https://www.linkedin.com/company/traceroot-ai" target="_blank" rel="noopener noreferrer"><img class="tr-docs-footer__social" src="${assets}linkedin.svg" width="13" height="13" alt="">LinkedIn</a>
            <a href="https://discord.gg/TM2m3CtKuC" target="_blank" rel="noopener noreferrer"><img class="tr-docs-footer__social" src="${assets}discord.svg" width="13" height="13" alt="">Discord</a>
          </div>
        </nav>
      </div>
      <div class="tr-docs-footer__legal">
        <span>© ${new Date().getFullYear()} traceroot</span>
        <nav class="tr-docs-footer__policies" aria-label="Legal and preferences">
          <a href="https://traceroot.ai/privacy">Privacy</a>
          <a href="https://traceroot.ai/terms">Terms</a>
          <button type="button" data-tr-action="cookies">Cookie settings</button>
        </nav>
        <button type="button" data-tr-action="top">Back to top ↑</button>
      </div>
      <div class="tr-docs-footer__wordmark" aria-hidden="true">
        <img src="${assets}footer-wordmark.svg" width="800" height="128" alt="">
        <canvas width="800" height="128" hidden></canvas>
      </div>
      <dialog class="tr-docs-footer__dialog" aria-labelledby="tr-docs-cookie-title" aria-describedby="tr-docs-cookie-description">
        <h2 id="tr-docs-cookie-title">Cookie preferences</h2>
        <p id="tr-docs-cookie-description"></p>
        <form>
          <label class="tr-docs-footer__choice"><input type="checkbox" name="analytics">Allow analytics</label>
          <p class="tr-docs-footer__status" role="status" hidden></p>
          <div class="tr-docs-footer__actions">
            <button type="button" data-tr-action="close">Cancel</button>
            <a href="https://traceroot.ai/" data-tr-website-settings hidden>Open website preferences</a>
            <button type="submit" data-tr-action="save">Save preferences</button>
          </div>
        </form>
      </dialog>`;
  }

  function mountWordmark() {
    const record = mounted;
    const runtime = window.TraceRootFooterWordmark;
    if (!record || !record.node.isConnected || record.node.hidden || record.wordmarkDispose || !runtime) return;
    const canvas = record.node.querySelector(".tr-docs-footer__wordmark canvas");
    const fallback = canvas.previousElementSibling;
    try {
      if (!canvas.getContext("2d")) return;
      for (const [property, value] of Object.entries(runtime.defaults)) canvas.style.setProperty(property, value);
      // Home is light-only. Retain its exact light palette and adapt the ink
      // to Mintlify's dark theme; the original factory reads colors at mount.
      if (document.documentElement.classList.contains("dark")) canvas.style.setProperty("--wm-ink", "var(--tr-text)");
      canvas.hidden = false;
      record.wordmarkDispose = runtime.mountFooterWordmark(canvas);
      fallback.hidden = true;
    } catch {
      canvas.hidden = true;
      fallback.hidden = false;
    }
  }

  function attachInteractions(node, events) {
    const dialog = node.querySelector("dialog");
    const description = dialog.querySelector("#tr-docs-cookie-description");
    const checkbox = dialog.querySelector('input[name="analytics"]');
    const choiceLabel = checkbox.closest("label");
    const save = dialog.querySelector('[data-tr-action="save"]');
    const website = dialog.querySelector("[data-tr-website-settings]");
    const status = dialog.querySelector('[role="status"]');
    let opener = null;

    node.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tr-action]");
      if (!button || !node.contains(button)) return;
      if (button.dataset.trAction === "top") {
        const title = document.getElementById("page-title");
        if (title) {
          const hadTabIndex = title.hasAttribute("tabindex");
          if (!hadTabIndex) title.setAttribute("tabindex", "-1");
          title.focus({ preventScroll: true });
          if (!hadTabIndex) title.addEventListener("blur", () => title.removeAttribute("tabindex"), { once: true, signal: events.signal });
        }
        window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      } else if (button.dataset.trAction === "cookies") {
        opener = button;
        const sdk = visitorAnalytics();
        const supported = !!sdk || localPreview;
        description.textContent = sdk
          ? "Essential storage keeps the site working. Choose whether to allow analytics on this documentation. Your choice uses the same preference as the TraceRoot website."
          : localPreview
            ? "Analytics are not loaded in this local preview. Saving only stores this preview’s preference; it does not change production analytics."
            : "Analytics preferences are unavailable on this documentation. You can manage website analytics using Cookie settings in the traceroot.ai footer; those settings may not apply to this page.";
        checkbox.checked = storedChoice() ? storedChoice() === "allowed" : sdk ? !sdk.has_opted_out_capturing() : true;
        choiceLabel.hidden = !supported;
        save.hidden = !supported;
        website.hidden = supported;
        status.hidden = true;
        dialog.showModal();
      } else if (button.dataset.trAction === "close") dialog.close();
    }, { signal: events.signal });

    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const sdk = visitorAnalytics();
      if (!sdk && !localPreview) return;
      const next = checkbox.checked ? "allowed" : "denied";
      try {
        applyChoice(sdk, next);
        visitChoice = next;
        try { localStorage.setItem(consentKey, next); } catch { /* Keep this visit's choice. */ }
        syncStoredChoice();
        dialog.close();
      } catch {
        status.textContent = "The preference could not be applied. Please try again.";
        status.hidden = false;
      }
    }, { signal: events.signal });

    dialog.addEventListener("close", () => opener?.focus(), { signal: events.signal });
    return dialog;
  }

  async function mount(attempt = 0, expected = generation) {
    if (expected !== generation) return;
    const host = document.querySelector('footer#footer[data-layout-item="footer"]');
    if (!host) {
      if (attempt < 12) timer = window.setTimeout(() => mount(attempt + 1, expected), 150);
      return;
    }
    if (mounted?.host === host && mounted.node.isConnected && !mounted.node.hidden) {
      if (mounted.dialog.open) mounted.dialog.close();
      return;
    }
    cleanMount();
    const node = document.createElement("section");
    node.className = "tr-docs-footer";
    node.setAttribute("aria-label", "TraceRoot");
    node.hidden = true;
    const prefix = /^\/docs(?:\/|$)/.test(location.pathname) ? "/docs" : "";
    node.innerHTML = footerMarkup(`${prefix}/brand/`);
    const events = new AbortController();
    const dialog = attachInteractions(node, events);
    host.append(node);
    const record = { host, node, events, dialog };
    mounted = record;
    try {
      const logo = node.querySelector(".tr-docs-footer__logo img");
      await logo.decode();
      if (expected !== generation || mounted !== record || !host.isConnected) return;
      if (getComputedStyle(node).getPropertyValue("--tr-footer-css-ready").trim() !== "1") {
        cleanMount();
        if (attempt < 12) timer = window.setTimeout(() => mount(attempt + 1, expected), 150);
        return;
      }
      node.hidden = false;
      host.setAttribute("data-tr-footer-ready", "");
      mountWordmark();
    } catch {
      if (mounted === record) cleanMount();
    }
  }

  function refresh() {
    window.clearTimeout(timer);
    generation += 1;
    syncStoredChoice();
    // A retained footer needs no remount; a replaced footer is cleaned up.
    void mount(0, generation);
  }

  window.addEventListener("mintlify:navigate", refresh, { signal: globalEvents.signal });
  window.addEventListener("traceroot:wordmark-ready", mountWordmark, { signal: globalEvents.signal });
  // Mintlify changes the html class when switching theme; no body observer.
  let dark = document.documentElement.classList.contains("dark");
  const themeObserver = new MutationObserver(() => {
    const next = document.documentElement.classList.contains("dark");
    if (next === dark) return;
    dark = next;
    if (!mounted) return;
    mounted.wordmarkDispose?.();
    mounted.wordmarkDispose = null;
    mountWordmark();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("load", syncStoredChoice, { once: true, signal: globalEvents.signal });
  window.addEventListener("storage", (event) => {
    if (event.key !== consentKey) return;
    visitChoice = undefined;
    syncStoredChoice();
  }, { signal: globalEvents.signal });

  window.__trDocsFooterAdapter = {
    refresh,
    dispose() {
      generation += 1;
      window.clearTimeout(timer);
      window.clearTimeout(consentTimer);
      globalEvents.abort();
      themeObserver.disconnect();
      cleanMount();
    },
  };
  syncStoredChoice();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh, { once: true, signal: globalEvents.signal });
  else refresh();
})();
