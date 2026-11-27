/**
 * Shows the website's language switcher in place of Mintlify's dropdown: a globe and text naming every
 * language the docs have ("EN/文"). One click opens the same page in the next language. Mintlify's own
 * dropdown stays in the page, hidden by custom.css only while this link is next to it.
 */
(() => {
  window.__trDocsLanguage?.dispose();
  const events = new AbortController();
  // Keep in step with navigation.languages in docs.json.
  const languages = [
    { code: "en", short: "EN", label: "English", prefix: "" },
    { code: "zh", short: "文", label: "简体中文", prefix: "/zh" },
  ];
  const home = "/getting-started/introduction";
  const globe =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/>' +
    '<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/></svg>';

  // A page without a translation links to the other language's first page. The hosted site lists every
  // page in its sitemap; the local preview has no sitemap and lists a page's translations in <head>.
  let pages = new Set();
  function target() {
    const base = /^\/docs(?:\/|$)/.test(location.pathname) ? "/docs" : "";
    const here = location.pathname.replace(/\/$/, "");
    const path = here.slice(base.length);
    const at = Math.max(0, languages.findIndex(({ prefix }) => prefix && (path + "/").startsWith(prefix + "/")));
    const next = languages[(at + 1) % languages.length];
    const samePage = base + next.prefix + (path.slice(languages[at].prefix.length) || home);
    const alternate = code => {
      const href = document.head.querySelector(`link[rel="alternate"][hreflang="${code}"]`)?.getAttribute("href");
      return href ? new URL(href, location.href).pathname.replace(/\/$/, "") : null;
    };
    // During a client-side navigation <head> can still describe the previous page.
    const translated = pages.has(samePage) || (alternate(languages[at].code) === here && alternate(next.code) === samePage);
    return { at, next, href: translated ? samePage : base + next.prefix + home };
  }

  function loadPages() {
    const base = /^\/docs(?:\/|$)/.test(location.pathname) ? "/docs" : "";
    fetch(`${base}/sitemap.xml`, { signal: events.signal })
      .then(response => (response.ok ? response.text() : ""))
      .then(xml => {
        pages = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname.replace(/\/$/, "")));
        mount();
      })
      .catch(() => {});
  }

  function update(link) {
    const { at, next, href } = target();
    link.href = href;
    link.hreflang = next.code;
    link.setAttribute("aria-label", `${at ? "语言" : "Language"}: ${next.label}`);
  }

  // The top bar has one dropdown. The phone menu renders a second one each time it opens.
  function mount() {
    for (const trigger of document.querySelectorAll('[data-component-part="localization-select-trigger"]')) {
      let link = trigger.nextElementSibling;
      if (!link?.classList.contains("tr-lang")) {
        link = document.createElement("a");
        link.className = "tr-lang";
        link.innerHTML = `${globe}<span aria-hidden="true">${languages.map(({ short }) => short).join("/")}</span>`;
        for (const type of ["pointerenter", "pointerdown", "focus"]) link.addEventListener(type, () => update(link));
        trigger.after(link);
      }
      update(link);
    }
  }

  let queued = 0;
  const added = new MutationObserver(() => {
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(mount);
  });
  added.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("mintlify:navigate", mount, { signal: events.signal });
  window.__trDocsLanguage = {
    refresh: mount,
    dispose() {
      events.abort();
      added.disconnect();
      cancelAnimationFrame(queued);
      document.querySelectorAll(".tr-lang").forEach(link => link.remove());
    },
  };
  loadPages();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true, signal: events.signal });
  else mount();
})();
