/** Native Mintlify owns footer links, logo and social icons; this adds brand controls. */
(() => {
  window.__trDocsFooterAdapter?.dispose();
  const globalEvents = new AbortController();
  let mounted = null;

  function cleanMount() {
    if (!mounted) return;
    mounted.wordmarkDispose?.();
    mounted.resize.disconnect();
    mounted.events.abort();
    if (mounted.dialog.open) mounted.dialog.close();
    mounted.additions.forEach(node => node.remove());
    mounted.classes.forEach(([node, name]) => node.classList.remove(name));
    mounted.host.style.removeProperty("margin-top");
    mounted.wrapper.style.removeProperty("width");
    mounted.wrapper.style.removeProperty("margin-left");
    mounted.host.style.removeProperty("--tr-footer-divider-left");
    mounted = null;
  }

  function extraMarkup(assets) {
    return `
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
        <p id="tr-docs-cookie-description">Analytics preferences are unavailable on this documentation. You can manage website analytics using Cookie settings in the traceroot.ai footer; those settings may not apply to this page.</p>
        <form method="dialog">
          <div class="tr-docs-footer__actions">
            <button type="submit">Cancel</button>
            <a href="https://traceroot.ai/">Open website preferences</a>
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
      } else if (button.dataset.trAction === "cookies") dialog.showModal();
    }, { signal: events.signal });

    return dialog;
  }

  // Advanced footers sit below the sidebar. Align with the article without
  // moving React-owned nodes or changing the sidebar's scrolling behavior.
  function alignFooter() {
    if (!mounted) return;
    const pagination = document.getElementById("pagination");
    if (!pagination) return;
    const bounds = pagination.getBoundingClientRect();
    const footer = mounted.host.getBoundingClientRect();
    const bar = document.querySelector("#content-area > [data-assistant-bar]");
    const barStyle = bar && getComputedStyle(bar);
    const barHeight = bar ? bar.offsetHeight + parseFloat(barStyle.marginTop) + parseFloat(barStyle.marginBottom) : 0;
    const end = bounds.bottom + barHeight;
    const flowTop = footer.top - parseFloat(getComputedStyle(mounted.host).marginTop);
    const column = document.getElementById("content-container");
    const dividerLeft = column && column.getBoundingClientRect().left - footer.left - 1;
    mounted.wrapper.style.width = `${bounds.width}px`;
    mounted.wrapper.style.marginLeft = `${bounds.left - footer.left}px`;
    mounted.host.style.marginTop = `${Math.min(0, end - flowTop)}px`;
    if (column) mounted.host.style.setProperty("--tr-footer-divider-left", `${dividerLeft}px`);
  }

  function observeArticle() {
    mounted.resize.disconnect();
    const article = document.getElementById("content") ?? document.getElementById("content-area");
    if (article) mounted.resize.observe(article);
    for (const selector of ["#pagination", "#content-area > [data-assistant-bar]"]) {
      const node = document.querySelector(selector);
      if (node) mounted.resize.observe(node);
    }
    alignFooter();
  }

  function mount() {
    const host = document.querySelector("footer#footer.advanced-footer[data-layout-item='footer']");
    if (mounted?.host === host && mounted.node.isConnected) {
      if (mounted.dialog.open) mounted.dialog.close();
      observeArticle();
      return;
    }
    cleanMount();
    if (!host) return;
    const wrapper = host.firstElementChild;
    const row = wrapper?.firstElementChild;
    const [brand, columns, socials] = row?.children ?? [];
    const logo = brand?.querySelector("a");
    if (!logo || !columns?.style.gridTemplateColumns || !socials?.querySelector("a svg")) return;

    const events = new AbortController();
    const node = document.createElement("div");
    node.className = "tr-docs-footer__extras";
    wrapper.append(node);
    // Without the enhancement layout, leave the native footer intact.
    if (getComputedStyle(node).display !== "contents") {
      node.remove();
      return;
    }
    const prefix = /^\/docs(?:\/|$)/.test(location.pathname) ? "/docs" : "";
    node.innerHTML = extraMarkup(`${prefix}/brand/`);
    const copy = document.createElement("div");
    copy.className = "tr-docs-footer__brand-copy";
    copy.innerHTML = '<p class="tr-docs-footer__description">Open source AI agent improvement platform.</p><p class="tr-docs-footer__eyebrow tr-docs-footer__location">San Francisco</p>';
    brand.append(copy);
    const heading = document.createElement("p");
    heading.className = "tr-docs-footer__eyebrow";
    heading.textContent = "Connect";
    socials.prepend(heading);
    const additions = [node, copy, heading];
    const labels = { x: "X", github: "GitHub", linkedin: "LinkedIn", discord: "Discord" };
    for (const link of socials.querySelectorAll("a")) {
      const label = document.createElement("span");
      label.textContent = labels[link.textContent.trim()] ?? link.textContent.trim();
      label.setAttribute("aria-hidden", "true");
      link.setAttribute("aria-label", label.textContent);
      link.append(label);
      additions.push(label);
    }
    const classes = [
      [host, "tr-docs-footer"], [wrapper, "tr-docs-footer__inner"],
      [row, "tr-docs-footer__row"], [brand, "tr-docs-footer__brand"],
      [columns, "tr-docs-footer__columns"], [socials, "tr-docs-footer__connect"],
    ];
    classes.forEach(([element, name]) => element.classList.add(name));
    mounted = { host, wrapper, node, events, additions, classes,
      dialog: attachInteractions(node, events), resize: new ResizeObserver(alignFooter) };
    window.addEventListener("resize", alignFooter, { signal: events.signal });
    observeArticle();
    mountWordmark();
  }

  window.addEventListener("mintlify:navigate", mount, { signal: globalEvents.signal });
  window.addEventListener("traceroot:wordmark-ready", mountWordmark, { signal: globalEvents.signal });
  window.__trDocsFooterAdapter = {
    refresh: mount,
    dispose() {
      globalEvents.abort();
      cleanMount();
    },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true, signal: globalEvents.signal });
  else mount();
})();
