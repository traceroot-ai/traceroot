/** Use the website's 192px favicon instead of Mintlify's generated 16/32px icons. */
(() => {
  const prefix = /^\/docs(?:\/|$)/.test(location.pathname) ? "/docs" : "";
  const href = `${prefix}/logo/favicon.png`;

  function apply() {
    for (const link of document.head.querySelectorAll('link[rel~="icon"]:not([data-tr-favicon])')) {
      link.remove();
    }
    if (document.head.querySelector("link[data-tr-favicon]")) return;
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    link.setAttribute("sizes", "192x192");
    link.href = href;
    link.dataset.trFavicon = "";
    document.head.append(link);
  }

  apply();
  new MutationObserver(apply).observe(document.head, { childList: true });
})();
