(() => {
  const visible = el => !!(el.getClientRects().length);
  const label = el => (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 120);
  const texts = selector => [...document.querySelectorAll(selector)].filter(visible).map(label).filter(Boolean).slice(0, 70);
  const clone = document.body?.cloneNode(true);
  clone?.querySelectorAll('script,style,input,textarea,table,[role=table],[role=row],[role=grid]').forEach(el => el.remove());
  const pluginHost = document.querySelector('example-ui');
  const shadow = pluginHost?.shadowRoot;
  const pluginLabels = shadow ? [...shadow.querySelectorAll('button,[role=button],h1,h2,h3,label,div,span')].filter(el => visible(el) && !el.children.length).map(label).filter(Boolean).slice(0, 35) : [];
  return {
    url: location.href,
    title: document.title,
    ready: document.readyState,
    bodyElementCount: document.body?.childElementCount || 0,
    interfaceTextWithoutRowsOrFields: (clone?.innerText || clone?.textContent || '').trim().slice(0, 2000),
    headings: texts('h1,h2,h3'),
    navigationLabels: texts('nav a,[role=menuitem]'),
    buttons: texts('button,[role=button]'),
    tableHeaders: texts('th,[role=columnheader]'),
    creatorNavigationLinks: [...document.querySelectorAll('a[href]')].filter(el => visible(el) && /查找达人|发现达人|达人管理|公开合作|定向合作/.test(label(el))).map(el => ({label: label(el), href: el.href})).slice(0, 12),
    visibleShopNameFound: /zig[\s.-]*zoom/i.test(document.body?.innerText || ''),
    plugin: {
      hostPresent: !!pluginHost,
      shadowPresent: !!shadow,
      hasPasswordField: !!shadow?.querySelector('input[type=password]'),
      visibleLabels: pluginLabels
    },
    iframeSources: [...document.querySelectorAll('iframe')].map(el => { try { const u = new URL(el.src); return u.origin + u.pathname; } catch { return null; } }).filter(Boolean).slice(0, 10)
  };
})()
