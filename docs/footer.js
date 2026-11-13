/** Native Mintlify owns footer links; this adds the brand wordmark and layout. */
(() => {
  window.__trDocsFooterAdapter?.dispose();
  const globalEvents = new AbortController();
  let mounted = null;

  function cleanMount() {
    if (!mounted) return;
    mounted.wordmarkDispose?.();
    mounted.resize.disconnect();
    mounted.events.abort();
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
      <div class="tr-docs-footer__wordmark" aria-hidden="true">
        <img src="${assets}footer-wordmark.svg" width="800" height="128" alt="">
        <canvas width="800" height="128" hidden></canvas>
      </div>`;
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
      observeArticle();
      return;
    }
    cleanMount();
    if (!host) return;
    const wrapper = host.firstElementChild;
    const row = wrapper?.firstElementChild;
    const [, columns] = row?.children ?? [];
    if (!columns?.style.gridTemplateColumns) return;

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
    const additions = [node];
    const classes = [
      [host, "tr-docs-footer"], [wrapper, "tr-docs-footer__inner"],
      [row, "tr-docs-footer__row"], [columns, "tr-docs-footer__columns"],
    ];
    classes.forEach(([element, name]) => element.classList.add(name));
    mounted = { host, wrapper, node, events, additions, classes, resize: new ResizeObserver(alignFooter) };
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
