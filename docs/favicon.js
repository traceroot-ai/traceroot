/**
 * Mintlify declares generated 16px and 32px tab icons, and browsers draw the
 * 16px one, so the mark looks smaller and thinner than on the website, which
 * declares only its 192px favicon.png. Declare that same single icon here.
 */
(() => {
  const prefix = /^\/docs(?:\/|$)/.test(location.pathname) ? "/docs" : "";
  const href = `${prefix}/logo/favicon.png`;

  function apply() {
    // rel~="icon" matches "icon" and "shortcut icon", not "apple-touch-icon".
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
  // Mintlify re-renders its head tags on client-side navigation.
  new MutationObserver(apply).observe(document.head, { childList: true });
})();
