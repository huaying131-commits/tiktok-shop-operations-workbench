'use strict';

(() => {
  const escape = input => String(input ?? '').replace(/[&<>"']/gu, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[char]);
  const list = value => Array.isArray(value) ? value : [];
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const number = value => count(value) ? value.toLocaleString('zh-CN') : '待核';
  const quantity = (value, unit) => count(value) ? `${number(value)} ${unit}` : '待核';
  const money = (value, currency) => {
    if (!/^[A-Z]{3}$/u.test(currency ?? '') || !/^-?\d+(?:\.\d{1,2})?$/u.test(String(value ?? ''))) return '待核';
    return escape(new Intl.NumberFormat('zh-CN', { style:'currency', currency }).format(Number(value)));
  };
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone:'Asia/Kuala_Lumpur', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  });
  const stamp = raw => Number.isFinite(Date.parse(raw)) ? date.format(new Date(raw)) : '读取时间待核';
  const localDay = raw => Number.isFinite(Date.parse(raw))
    ? new Date(Date.parse(raw) + 8*60*60*1000).toISOString().slice(0,10) : null;
  const timestamp = seconds => count(seconds) && seconds>0 && seconds<=8.64e12
    ? new Date(seconds*1000).toISOString() : null;
  const days = value => value?.start && value?.endExclusive ? `${value.start} 至 ${value.endExclusive} 前` : '统计日期待核';
  const procurement = '/operations?tab=inventory#procurement-tasks';
  const publishing = '/operations?tab=publishing#publish-review';
  const cell = content => `<td>${content}</td>`;
  const row = columns => `<tr>${columns.map(cell).join('')}</tr>`;
  const table = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const blank = text => `<p class="detail-empty">${text}</p>`;
  const foot = text => `<p class="ops-foot">${text}</p>`;
  const link = (href,text) => `<a class="row-link" href="${href}">${text} ↗</a>`;
  const symbols = {
    'warehouse-today':'M3 9l9-5 9 5v11H3zM7 20v-7h10v7',
    'publish-today':'M3 6h18v12H3zm7 3 5 3-5 3z',
    'product-top':'M4 7h16v13H4zm4 0V5a4 4 0 0 1 8 0v2',
    'stock-watch':'M3 7l9-4 9 4-9 4zm0 0v10l9 4 9-4V7m-9 4v10',
    'listing-heatmap':'M4 7h16v14H4zm0 4h16M8 4v5m8-5v5m-7 7h2m2 0h2',
    'sales-trend':'M4 4v16h16M7 16l5-5 4 2 4-6',
    conversion:'M3 5h18l-7 8v5l-4 2v-7z',
    'today-tasks':'M6 5h12v15H6zm3 8 2 2 4-4',
    fulfillment:'M3 6h12v11H3zm12 4h4l2 3v4h-6M7 20a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 7 20zm11 0a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 18 20z',
    'product-catalogue':'M4 7h16v13H4zm4 0V5a4 4 0 0 1 8 0v2',
    'listing-receipts':'M4 7h16v14H4zm0 4h16M8 4v5m8-5v5m-7 7h2m2 0h2',
    'publish-review':'M3 6h18v12H3zm7 3 5 3-5 3z',
    'publication-history':'M4 7h16v14H4zm0 4h16M8 4v5m8-5v5m-7 7h2m2 0h2',
    discount:'M3 4h7l10 10-7 7L3 11zM7 8h.01',
    settlement:'M4 5h16v14H4zM4 10h16M8 15h3m3 0h2',
    'after-sales':'M4 12a8 8 0 0 1 16 0v5h-5v-5h5M4 12h5v5H4zm12 5v2a2 2 0 0 1-2 2h-3',
  };
  const glyph = path => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const box = (id,title,body,action='') => {
    const symbol = symbols[id];
    const graphic = `<span class="icon-tile">${glyph(symbol ?? symbols['today-tasks'])}</span>`;
    return `<section id="${id}" class="panel ops-extra" aria-labelledby="${id}-title"><header class="panel-head"><h2 id="${id}-title">${graphic}${title}</h2>${action}</header>${body}</section>`;
  };
  const accounts = [
    ['example-creator-1','仓储主号'], ['example-creator-2','Angele 探店'], ['example-creator-3','Snap TOY 桌拍'],
    ['example-creator-4','MRTOY 探展'], ['example-creator-5','Baikyunee 生活'],
  ];
  const routes = { china_direct:'好货来 · 中国直发', malaysia_overseas:'马来西亚海外仓' };
  const warehouseNames = { '879':'好货来 · 东莞', '892':'好货来 · 义乌', '148':'神牛仓', '80':'战马仓' };
  const warehouseOptions = Object.entries(warehouseNames).map(([id,name])=>[id,name]);
  const warehouseName = id => warehouseNames[id] ?? (id ? `仓库 ${id}` : '具体仓待核');
  const productPhoto = (url,title) => typeof url==='string' && /^\/api\/operations\/dashboard\/images\/\d+\/(?:\d+|cover)$/u.test(url)
    ? `<img class="rank-photo" src="${escape(url)}" alt="" loading="lazy" />`
    : `<span class="rank-photo rank-placeholder" role="img" aria-label="${escape(title)}暂无图片">${glyph(symbols['product-top'])}</span>`;

  function readback(source) {
    if (!source?.observedAt) return '';
    return `<div class="receipt-origin"><span>读取时间 ${escape(stamp(source.observedAt))}（UTC+8）</span>${source.path ? `<code>${escape(source.path)}</code>` : ''}</div>`;
  }

  const filters = new Map();
  const filterModels = new Map();
  const filterPages = new Map();
  const pageSize = 24;
  const normalized = value => String(value ?? '').toLocaleLowerCase('zh-CN');
  const matches = (fields,state) => Object.entries(state).every(([key,value]) =>
    !value || (key==='query' ? normalized(fields.query).includes(normalized(value).trim()) : fields[key]===value));
  const filterRecords = (id, records) => records.filter(record=>matches(record.fields,filters.get(id) ?? {}));
  const pagerState = (id,total) => {
    const pages = Math.max(1,Math.ceil(total / pageSize));
    return { pages, page:Math.min(filterPages.get(id) ?? 1,pages) };
  };
  const visibleRows = (records,page) => records.slice((page-1)*pageSize,page*pageSize).map(record=>row(record.columns)).join('');

  function filterTable(id,head,records,inputs,noneFound,intro='') {
    const state = filters.get(id) ?? {};
    filterModels.set(id,records);
    const filtered = filterRecords(id,records);
    const { pages,page } = pagerState(id,filtered.length);
    filterPages.set(id,page);
    const controls = inputs.map(({key,label,options,placeholder})=>{
      const value = state[key] ?? '';
      const control = options
        ? `<select data-filter-key="${key}">${options.map(([v,l])=>`<option value="${escape(v)}"${v===value?' selected':''}>${escape(l)}</option>`).join('')}</select>`
        : `<input data-filter-key="${key}" type="search" value="${escape(value)}" placeholder="${escape(placeholder)}" autocomplete="off">`;
      return `<label>${escape(label)}${control}</label>`;
    }).join('');
    return `<div class="workspace-records" data-filter-table="${id}">${intro}
      <div class="workspace-filters">${controls}<span class="filter-count" data-filter-count aria-live="polite">${number(filtered.length)} 条记录</span></div>
      <div class="table-wrap"><table><thead><tr>${head.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody data-filter-rows>${visibleRows(filtered,page)}</tbody></table></div>
      <p class="detail-empty" data-filter-empty${filtered.length?' hidden':''}>${noneFound}</p>
      <div class="workspace-pager" data-filter-pager${pages===1?' hidden':''}>
        <button type="button" data-filter-step="-1"${page===1?' disabled':''}>上一页</button>
        <span data-filter-page aria-live="polite">${page} / ${pages} 页</span>
        <button type="button" data-filter-step="1"${page===pages?' disabled':''}>下一页</button>
      </div></div>`;
  }

  function refreshFilter(host) {
    const key = host.dataset.filterTable;
    const filtered = filterRecords(key,filterModels.get(key) ?? []);
    const { pages,page } = pagerState(key,filtered.length);
    filterPages.set(key,page);
    host.querySelector('[data-filter-rows]').innerHTML = visibleRows(filtered,page);
    host.querySelector('[data-filter-count]').textContent = `${number(filtered.length)} 条记录`;
    host.querySelector('[data-filter-empty]').hidden = filtered.length !== 0;
    host.querySelector('[data-filter-pager]').hidden = pages === 1;
    host.querySelector('[data-filter-page]').textContent = `${page} / ${pages} 页`;
    host.querySelector('[data-filter-step="-1"]').disabled = page===1;
    host.querySelector('[data-filter-step="1"]').disabled = page===pages;
  }

  function applyFilter(event) {
    const input = event.target.closest('[data-filter-key]');
    const host = input?.closest('[data-filter-table]');
    if (!host) return;
    const key = host.dataset.filterTable;
    if (filters.get(key)?.[input.dataset.filterKey]===input.value) return;
    filters.set(key,{ ...filters.get(key), [input.dataset.filterKey]:input.value });
    filterPages.set(key,1);
    refreshFilter(host);
  }
  const dashboardHost = document.getElementById('dashboard-content');
  dashboardHost.addEventListener('input',applyFilter);
  dashboardHost.addEventListener('change',applyFilter);
  dashboardHost.addEventListener('click',event=>{
    const step = event.target.closest('button[data-filter-step]');
    const host = step?.closest('[data-filter-table]');
    if (!host) return;
    const key = host.dataset.filterTable;
    filterPages.set(key,Math.max(1,(filterPages.get(key) ?? 1)+Number(step.dataset.filterStep)));
    refreshFilter(host);
  });

  function warehousePriority(fulfillment) {
    const totals = fulfillment?.liveTotals ?? fulfillment;
    const supplied = list(fulfillment?.warehouses);
    const groups = [
      ['china_direct','好货来 · 中国直发', [['879','东莞仓'], ['892','义乌仓']]],
      ['malaysia_overseas','马来西亚海外仓', [['148','神牛仓'], ['80','战马仓']]],
    ];
    const metric = (value,coverage) => coverage === 'verified' ? quantity(value,'单') :
      count(value) && value>0 ? `${quantity(value,'单')} <small>已核</small>` : '<span class="warehouse-unknown">待核</span>';
    const rows = groups.flatMap(([route,name,warehouses])=>{
      const group = list(fulfillment?.byRoute).find(item=>item.route===route);
      const pending = group?.unassignedPendingShipment;
      const awaiting = group?.unassignedAwaitingCollection;
      const groupLabel = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${symbols['warehouse-today']}"/></svg>${name}`;
      const lines = warehouses.map(([id,label])=>{
        const warehouse = supplied.find(item=>item.warehouseId===id);
        return row([`<b>${label}</b>`,metric(warehouse?.pendingShipment,warehouse?.pendingCoverage),metric(warehouse?.awaitingCollection,warehouse?.collectionCoverage)]);
      });
      const unresolved = pending>0 || awaiting>0 ? row(['<a class="warehouse-unknown" href="/operations?tab=orders#fulfillment">具体仓待核 ↗</a>', quantity(pending,'单'), quantity(awaiting,'单')]) : '';
      return `<tbody><tr class="warehouse-group"><th scope="rowgroup">${groupLabel}</th><td>${quantity(group?.pendingShipment,'单')}</td><td>${quantity(group?.awaitingCollection,'单')}</td></tr>${lines.join('')}${unresolved}</tbody>`;
    });
    if (fulfillment?.pendingRouteUnknown>0 || fulfillment?.collectionRouteUnknown>0) {
      rows.push(`<tbody>${row(['<b>发货路线待核</b>',quantity(fulfillment.pendingRouteUnknown,'单'),quantity(fulfillment.collectionRouteUnknown,'单')])}</tbody>`);
    }
    return box('warehouse-today','各仓待发货',
      `<div class="ops-summary"><b>${quantity(totals?.pendingShipment,'单')}</b><span>待发货</span><b>${quantity(totals?.awaitingCollection,'单')}</b><span>待揽收</span></div>`+
      `<div class="table-wrap"><table><thead><tr><th scope="col">仓库</th><th scope="col">待发货</th><th scope="col">待揽收</th></tr></thead>${rows.join('')}</table></div>`+
      foot(fulfillment?.kind === 'orders_snapshot'
        ? `总数按订单列表 ${escape(stamp(fulfillment.source?.observedAt))} · 等待分仓回查`
        : fulfillment?.isCurrentDay === false
        ? `上次回查 ${escape(stamp(fulfillment.source?.observedAt))} · 跨日沿用，等待今日回查`
        : `${fulfillment?.liveTotals ? `总数按订单列表 ${escape(stamp(totals.source?.observedAt))} · ` : ''}分仓回查 ${escape(stamp(fulfillment?.source?.observedAt))}`),link('/operations?tab=orders#fulfillment','看待发订单'));
  }

  function publishPriority(pub) {
    const cap = pub?.perAccountCap;
    const detailed = document.body.dataset.workspacePage === 'publishing';
    const rows = accounts.map(([account,label]) => {
      const result = list(pub?.accounts).find(x=>x.account===account);
      const confirmed = result?.progressCount;
      const pending = result?.pendingReadback;
      const planned = count(confirmed) && count(cap);
      const remaining = planned ? Math.max(0,cap-confirmed) : null;
      const bar = planned && cap>0 ? `<progress max="${cap}" value="${Math.min(confirmed,cap)}" aria-label="发布回执进度"></progress>` : '';
      const hasPending = list(result?.pending).length>0;
      const pendingValue = hasPending ? `<a href="${publishing}" title="查看原提交回执">${number(pending)} ↗</a>` : number(pending);
      const columns = [`<b>${label}</b><small>@${account}</small>`,`<span class="account-count"><span>${number(confirmed)} / ${number(cap)}</span>${bar}</span>`,
        pendingValue,number(remaining)];
      if (detailed) columns.push(result?.nextAt ? escape(stamp(result.nextAt)) : '待核');
      return row(columns);
    });
    const summary = `<div class="ops-summary"><b>${number(pub?.progressCount)} / ${number(pub?.target)}</b><span>账本成功回执 / 今日目标</span><b>${quantity(pub?.pendingPublicAnchor,'条')}</b><span>待核公开与挂车</span></div>`;
    const platformCount = pub?.platformCountComplete===true && count(pub.officialCount)
      ? `平台公开 ${quantity(pub.officialCount,'条')}` : '平台公开总数待核';
    const headers = ['账号','账本 / 上限','待回查','差额'];
    if (detailed) headers.push('下次时间参考');
    return box('publish-today','五账号发布进度',summary+table(headers,rows)+
      foot(`账本更新 ${escape(stamp(pub?.localObservedAt))} · ${platformCount}`),link(publishing,'看回执'));
  }

  function todayTasks(data) {
    const pub = data?.workflow?.publication;
    const ship = data?.fulfillment?.liveTotals ?? data?.fulfillment;
    const todo = [];
    if (count(ship?.pendingShipment) && ship.pendingShipment > 0) {
      const issue=list(data?.suggestions).find(x=>x.kind==='fulfillment');
      const summary = ship.isCurrentDay===false ? `上次回查有 ${ship.pendingShipment} 单待发，等待今日订单回查` :
        `${ship.pendingShipment} 单待发，先核仓库和实际可发库存`;
      todo.push([issue?.title ?? '查待发订单',data?.fulfillment?.liveTotals ? summary : issue?.detail ?? summary,'/operations?tab=orders#fulfillment']);
    }
    if (count(pub?.pendingReadback) && pub.pendingReadback > 0) todo.push(['回查视频与商品卡',`${pub.pendingReadback} 条待核平台公开或商品卡`,publishing]);
    const service = data?.afterSales?.open;
    if (service?.distinctCases > 0 && localDay(service.source?.observedAt)===data?.day) {
      todo.push(['查看退款与平台争议',`最近回查有 ${number(service.distinctCases)} 笔售后待处理`,'/operations?tab=orders#after-sales']);
    }
    for (const item of list(data?.suggestions).filter(x=>x.kind==='procurement').slice(0,1)) {
      todo.push([item.title,item.detail,procurement]);
    }
    const body = todo.length ? `<div class="ops-tasks">${todo.map(([title,text,href],i)=>`<a href="${href}"><span aria-hidden="true">${i+1}</span><strong>${escape(title)}</strong><small>${escape(text)}</small></a>`).join('')}</div>` :
      blank('当前快照没有可确认的待办。各卡片仍显示数据是否待核。');
    return box('today-tasks','今日待办',body,document.body.dataset.workspacePage === 'tasks' ? '' : link('/operations?tab=tasks#role-tasks','看全部任务'));
  }

  function funnelPane(data) {
    const funnel = data?.shop?.funnel ?? data?.shop?.sales?.funnel ?? data?.funnel;
    const rows = [
      ['商品曝光',funnel?.impressions,'M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zm10-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
      ['商品点击',funnel?.clicks,'M4 7h16v13H4zm4 0V5a4 4 0 0 1 8 0v2'],
      ['加购',funnel?.cartAdds,'M2 4h3l2 11h11l3-8H6m2 12h1m8 0h1'],
      ['商品分析订单',funnel?.orders,'M6 4h12v16H6zm3 5h6m-6 4h6m-6 4h3'],
    ];
    const max = count(funnel?.impressions) && funnel.impressions>0 ? funnel.impressions : null;
    return box('conversion','店铺转化漏斗',
      `<div class="ops-funnel">${rows.map(([label,n,symbol])=>`<div class="funnel-row"><svg class="icon funnel-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${symbol}"/></svg><b>${label}</b>${count(n)&&max?`<progress max="${max}" value="${Math.min(n,max)}" aria-label="${label}"></progress>`:'<span class="funnel-unknown">—</span>'}<strong class="funnel-value">${number(n)}</strong><small class="funnel-pct">${count(n)&&max?`${(n/max*100).toFixed(n===max?0:1)}%`:'—'}</small></div>`).join('')}</div>`+
      foot(funnel?`${escape(days(funnel.window))} · 覆盖 ${quantity(funnel.coverage,'款')}商品 · 比例以曝光为基准`:'等待同一统计区间的商品数据。'));
  }

  function rankedProducts(data) {
    const ranked=data?.productRank ?? data?.shop?.productRank;
    const values=list(ranked?.rows ?? ranked).slice(0,6);
    const maxUnits=Math.max(1,...values.filter(r=>count(r.itemsSold)).map(r=>r.itemsSold));
    const rows=values.map((r,index)=>{
      const title = escape(r.title ?? r.name ?? r.sellerSku ?? '商品名待核');
      const photo = productPhoto(r.imageUrl,r.title ?? r.name ?? r.sellerSku ?? '商品');
      const bar = count(r.itemsSold) ? `<progress class="product-rank-bar" max="${maxUnits}" value="${r.itemsSold}" aria-hidden="true"></progress>` : '';
      return row([`<span class="rank-chip">${number(index+1)}</span>`,`<button class="rank-product" data-entry="product-${index}" type="button">${photo}<b title="${title}">${title}</b></button>`,
        `<span class="product-quantity">${bar}<strong>${quantity(r.itemsSold,'件')}</strong></span>`,quantity(r.orders,'单')]);
    });
    return box('product-top','热卖商品 TOP6',rows.length ? table(['#','商品','售出','订单'],rows)+
      foot(`${escape(days(ranked.window))} · ${escape(ranked.basis ?? '按可核订单统计')}`) : blank('等待完整订单里的商品和数量，匹配后再排名。'),
    document.body.dataset.workspacePage === 'products' ? '' : link('/operations?tab=products','看商品'));
  }

  function listingPane(listing) {
    const items = list(listing?.days);
    const dots = items.map(r=>{
      const n = r.verifiedCount;
      const label = `${r.day} · ${count(n)?`确认在售 ${n} 款`:'暂无核实记录'}`;
      const day = typeof r.day==='string' ? r.day.slice(5) : '—';
      return `<div class="heat-day" data-level="${count(n)?Math.min(n,4):'unknown'}" title="${escape(label)}"><time>${escape(day)}</time><strong>${count(n)?number(n):'—'}</strong></div>`;
    }).join('');
    const legend = '<div class="heat-legend"><span data-level="unknown">待核</span><span data-level="0">0 款</span><span data-level="1">1 款</span><span data-level="2">2 款</span><span data-level="3">3 款</span><span data-level="4">4 款以上</span></div>';
    return box('listing-heatmap','近四周上架热力图',items.length ?
      legend+`<div class="ops-heat">${dots}</div>`+foot(`${escape(listing.startDay)} 至 ${escape(listing.endDay)} · 只计有平台在售回执的商品。灰格表示暂无核实记录。`) :
      blank('等商品上架后的平台在售回执。'));
  }

  function summaryPanel(id,title,fields,note,href) {
    return box(id,title,`<div class="ops-summary-table">${fields.map(([label,metric])=>`<div><span>${label}</span><strong>${metric}</strong></div>`).join('')}</div>`+
      foot(note),href ? link(href,'看明细') : '');
  }

  function publicationHistory(pub) {
    const rows=list(pub?.trend);
    const data=rows.map(x=>`<div class="heat-day" data-level="${count(x.progressCount)?Math.min(4,x.progressCount):'unknown'}"><time>${escape(x.day?.slice(5))}</time><strong>${number(x.progressCount)}</strong><small>待核 ${number(x.pendingReadback)}</small></div>`).join('');
    return box('publication-history','近7日发布',rows.length ? `<div class="ops-heat">${data}</div>`+
      foot('条数按发布成功回执统计，公开与商品卡单独回查。') : blank('等待逐日本地发布和平台回读。'),link(publishing,'看回查'));
  }

  function publicationPending(pub) {
    const entries = list(pub?.accounts).flatMap(account=>list(account.pending).map(video=>({...video,account:account.account})));
    const statusLabels = { matched:'匹配平台数据，公开和商品卡待核', acknowledged:'成功回执，公开和商品卡待核', unknown:'提交结果待核' };
    const records = entries.map(video=>{
      const status = video.platformMatched ? 'matched' : video.acknowledged ? 'acknowledged' : 'unknown';
      return {
        fields:{query:`${video.jobId ?? ''} ${video.productId ?? ''}`,account:video.account,status},
        columns:[`<b>@${escape(video.account)}</b>`,`<b>${escape(video.jobId ?? '待核')}</b><small>商品 ID ${escape(video.productId ?? '待核')}</small>`,
          escape(stamp(video.attemptedAt)),`<span class="status">${statusLabels[status]}</span>`,
          status==='unknown' ? '回查原提交结果' : '核公开原帖和商品卡'],
      };
    });
    const currentPage = document.body.dataset.workspacePage === 'publishing';
    const head = ['账号','视频任务与商品','提交时间','回执状态','下一步'];
    let body = blank(pub?.pendingReadback===0 ? '账本当前没有待回查记录。' : '尚未读到可展示的待回查记录。');
    if (records.length && currentPage) {
      body = filterTable('publish-review',head,records,[
        {key:'query',label:'查找回执',placeholder:'输入任务 ID 或商品 ID'},
        {key:'account',label:'发布账号',options:[['','全部账号'],...accounts]},
        {key:'status',label:'回执状态',options:[['','全部状态'],...Object.entries(statusLabels)]},
      ],'没有符合筛选条件的回执。');
    } else if (records.length) {
      body = table(head,records.slice(0,4).map(record=>row(record.columns)));
    }
    return box('publish-review','视频发布回查',body,currentPage ? '' : link(publishing,'看全部回执'));
  }

  function afterSalesPane(service, day) {
    const { open,recent,inbox } = service ?? {};
    const prior = open && localDay(open.source?.observedAt)!==day;
    const time = source => escape(stamp(source?.observedAt));
    const recentWindow = recent?.window;
    const facts = [
      ['待商家审核',quantity(open?.pendingReturnRefund,'笔')],
      ['平台仲裁中',quantity(open?.inArbitration,'笔')],
      ['两类合计（去重）',quantity(open?.distinctCases,'笔')],
      ['未读会话',quantity(inbox?.unreadConversations,'个')],
    ];
    const overview = `<dl class="row-facts activity-facts">${facts.map(([label,value])=>
      `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
    const statuses = {pending:'待商家审核',arbitration:'平台仲裁中',both:'待审核及平台仲裁中'};
    const cases = list(open?.rows).map(item=>{
      const state = item.inArbitration ? (item.pendingReturnRefund ? 'both' : 'arbitration') : 'pending';
      return {fields:{query:item.orderSuffix,state}, columns:[`<b>${escape(item.orderSuffix)}</b>`,
        `<span class="status">${statuses[state]}</span>`,
        money(item.amount,'MYR'),escape(stamp(timestamp(item.updatedAt))),item.exact===true ? '订单与规格已匹配' : '订单或规格待核']};
    });
    const details = cases.length ? filterTable('after-sales',['订单尾号','状态','申请金额','最近更新（马来时间）','核对结果'],cases,[
      {key:'query',label:'找售后订单',placeholder:'输入订单尾号'},
      {key:'state',label:'处理状态',options:[['','所有状态'],...Object.entries(statuses)]},
    ],'没有符合筛选条件的售后记录。') : blank(open?.distinctCases===0
      ? '这次读取的待审核及平台处理中记录为 0 笔。' : '尚未读到可展示的售后明细。');
    const observed = open ? foot(`${prior ? '上次回查' : '本日回查'} ${time(open.source)} · 换货与补发覆盖近期更新窗口`) : '';
    const recentNote = recentWindow ? foot(`近期售后 ${quantity(recent.records,'笔')} · ${escape(stamp(timestamp(recentWindow.startInclusive)))} 至 ${escape(stamp(timestamp(recentWindow.endExclusive)))}（不含）`) : '';
    const inboxNote = inbox ? foot(`客服未读会话读取于 ${time(inbox.source)}`) : '';
    return box('after-sales','退款与客服',overview+observed+details+recentNote+inboxNote);
  }

  function salesChart(sales) {
    const rows = list(sales?.series).filter(x=>x.day && count(x.orders) && /^\d+(?:\.\d+)?$/u.test(String(x.gmv))).sort((a,b)=>a.day.localeCompare(b.day));
    if (rows.length < 2) return box('sales-trend','成交额与订单走势',blank('等待至少两天的完整店铺报表。'));
    const gmvLimit=Math.max(1,Math.ceil(Math.max(...rows.map(x=>Number(x.gmv)))/100)*100);
    const orderLimit=Math.max(4,Math.ceil(Math.max(...rows.map(x=>x.orders))/4)*4);
    const x=i=>48+i*680/(rows.length-1);
    const y=(n,max)=>148-126*n/max;
    const line=(key,max,kind)=>{
      const points=rows.map((d,i)=>`${x(i)},${y(d[key],max)}`);
      return `<polygon points="${x(0)},${y(0,max)} ${points.join(' ')} ${x(rows.length-1)},${y(0,max)}" fill="url(#trend-${kind})"/><polyline points="${points.join(' ')}" class="trend-line ${kind}"/>${rows.map((d,i)=>`<circle cx="${x(i)}" cy="${y(d[key],max)}" r="3.2" class="trend-point ${kind}"><title>${escape(d.day)} · ${kind==='revenue'?'RM ':''}${escape(d[key])}${kind==='orders'?' 单':''}</title></circle>`).join('')}`;
    };
    const guides=[0,1,2,3,4].map(i=>{
      const position=y(i,4);
      return `<line x1="${x(0)}" x2="${x(rows.length-1)}" y1="${position}" y2="${position}" class="trend-guide"/><text x="41" y="${position+4}" text-anchor="end">${Math.round(gmvLimit*i/4)}</text><text x="735" y="${position+4}">${Math.round(orderLimit*i/4)}</text>`;
    }).join('');
    return box('sales-trend',`近 ${rows.length} 日成交趋势`,`<div class="ops-trend"><svg viewBox="0 0 771 173" role="img" aria-label="按日期的成交额与订单双线图"><defs><linearGradient id="trend-revenue" x2="0%" y2="100%"><stop stop-color="#ff8a25" stop-opacity=".32"/><stop offset="1" stop-color="#ff8a25" stop-opacity=".025"/></linearGradient><linearGradient id="trend-orders" x2="0%" y2="100%"><stop stop-color="#1bb967" stop-opacity=".24"/><stop offset="1" stop-color="#1bb967" stop-opacity=".035"/></linearGradient></defs>${guides}${line('gmv',gmvLimit,'revenue')}${line('orders',orderLimit,'orders')}${rows.map((d,i)=>`<text x="${x(i)}" y="167" text-anchor="middle">${escape(d.day.slice(5))}</text>`).join('')}</svg></div>`+foot(escape(days(sales.window))),'<div class="chart-legend"><span>GMV（RM）</span><span>成交订单（单）</span></div>');
  }

  window.renderOperationsDashboardSummary = (data, adsPreview) => `<div class="overview-deck">
    <div class="overview-operations overview-priorities">${adsPreview}${warehousePriority(data?.fulfillment)}${publishPriority(data?.workflow?.publication)}</div>
  </div>`;
  window.renderOperationsDashboardTasks = data => todayTasks(data);
  window.renderOperationsDashboardAnalysis = data => `<div class="overview-charts overview-analysis">${salesChart(data?.shop?.sales)}${funnelPane(data)}</div>`;
  function stockPane(p, limit=4) {
    const rows=list(p?.rows).slice(0,limit);
    return box('stock-watch','库存预警与采购',rows.length ?
      table(['复核商品','下一步'],rows.map(item=>row([`<b>${escape(item.title?.replace(/^复核备货草案\s*·\s*/u,''))}</b>`,item.state==='approval'?'核库存、报价与到仓时间':'查仓库货号'])))+
      foot(`${quantity(p.approvalCount,'项')}采购草案待确认 · ${escape(stamp(p.source?.observedAt))}`) :
      blank('暂无可展示的库存和采购回执。'),
    document.body.dataset.workspacePage === 'inventory' ? '' : link(procurement,'看采购任务'));
  }
  window.renderOperationsDashboardMedia = (data,videos) =>
    `<div class="overview-operations overview-media">${videos}${stockPane(data?.procurement)}${rankedProducts(data)}</div>`;

  function promotionPane(data) {
    const discount=data?.promotion?.coverage;
    return summaryPanel('discount','折扣与活动',[
      ['正在进行',quantity(discount?.ongoingActivities,'项')],
      ['有活动的在售品',quantity(discount?.coveredProducts,'款')],
      ['未参加的在售品',quantity(discount?.uncoveredProducts,'款')],
    ],escape(stamp(discount?.source?.observedAt))+(data?.sync?.pilotError ? ' · 试点价格或订单待回查' : ''));
  }

  function settlementPane(finance) {
    return summaryPanel('settlement','结算与利润',[
      ['已结算净额',money(finance?.paidNet,finance?.currency)],
      ['已结算订单',quantity(finance?.paidOrders,'单')],
      ['预计净结算',money(finance?.estimatedNet,finance?.currency)],
      ['预计结算订单',quantity(finance?.estimatedOrders,'单')],
      ['已读结算明细',quantity(finance?.settledLines,'条')],
      ['退货记录',quantity(finance?.returns,'条')],
      ['店铺利润',finance?.actualProfit===null || finance?.actualProfit===undefined ? '待合并成本与结算' : money(finance.actualProfit,finance.currency)],
    ],finance ? `结算快照 ${escape(stamp(finance.source?.observedAt))}${finance.window ? ` · ${escape(stamp(finance.window.startAt))} 至 ${escape(stamp(finance.window.endExclusiveAt))}前` : ''}` : '暂未读到结算回执。');
  }

  const roleNames = {
    procurement:'采购备货', 'video-production':'视频制作',
    'video-publishing':'视频发布', 'ads-analysis':'广告分析',
  };
  const taskStates = { approval:'待确认', queued:'待跟进', retry:'等待重试' };
  const taskPriorities = { urgent:'优先处理',normal:'常规' };
  function roleQueue(data, id, title, role) {
    const tasks=list(data?.roleTasks).filter(task=>!role || task.role===role);
    const filters = [
      { key:'query',label:'查找任务',placeholder:'输入任务名称' },
      { key:'state',label:'状态',options:[['','全部状态'],...Object.entries(taskStates)] },
      { key:'priority',label:'优先级',options:[['','全部优先级'],...Object.entries(taskPriorities)] },
    ];
    if (!role) filters.push({ key:'role',label:'负责岗位',options:[['','全部岗位'],...Object.entries(roleNames)] });
    return box(id,title,tasks.length ? filterTable(id,['任务','负责岗位','优先级','状态','更新时间'],tasks.map(task=>({
      fields:{ query:task.title ?? task.key,state:task.state,role:task.role,priority:task.priority },
      columns:[
        `<b>${escape(task.title ?? task.key)}</b>`,
        escape(roleNames[task.role] ?? task.role),
        `<span class="status"${task.priority==='urgent'?' data-tone="error"':''}>${escape(taskPriorities[task.priority] ?? '待核')}</span>`,
        `<span class="status">${escape(taskStates[task.state] ?? '待核')}</span>`,
        escape(stamp(task.updatedAt)),
      ],
    })),filters,'没有符合筛选条件的任务。') : blank(Array.isArray(data?.roleTasks)
      ? '当前岗位队列没有待处理任务。' : '等待读取岗位任务。'));
  }

  function cataloguePane(catalogue) {
    const statuses = {
      ACTIVATE:'在售', ACTIVE:'在售', DRAFT:'草稿', PENDING:'审核中', UNDER_REVIEW:'审核中',
      DEACTIVATED:'已下架', SELLER_DEACTIVATED:'已下架', SUSPENDED:'暂停销售',
      FREEZE:'冻结', FROZEN:'冻结', DELETED:'已删除', FAILED:'审核未通过',
    };
    const products = list(catalogue?.rows);
    const catalogueSource = catalogue?.catalogSource ?? catalogue?.rowsSource ?? catalogue?.source;
    if (!products.length) return box('product-catalogue','商品目录',catalogue?.rows?.length===0
      ? blank('该目录快照没有商品。')+readback(catalogueSource) :
      blank('等待完整商品目录快照。已核在售的商品可在下方查看。'));
    const records = products.map(product=>{
      const title = product.title ?? '商品标题待核';
      const status = Object.hasOwn(statuses,product.status) ? statuses[product.status] : '状态待核';
      const variants = list(product.variants);
      const lines = variants.map(variant=>row([
        escape(variant.sellerSku ?? variant.skuId ?? '待核'),
        money(variant.price,variant.currency),
        quantity(variant.stock,'件'),
      ]));
      const details = lines.length
        ? `<details class="row-receipt"><summary>查看 ${number(lines.length)} 个 SKU</summary>${table(['商家 SKU','挂牌价','平台挂牌库存'],lines)}</details>`
        : 'SKU 待核';
      return {
        fields:{ query:[title,product.productId,...variants.flatMap(variant=>[variant.sellerSku,variant.skuId])].join(' '), status },
        columns:[`<div class="catalogue-product">${productPhoto(product.imageUrl,title)}<span><b>${escape(title)}</b><small>ID ${escape(product.productId ?? '待核')}</small></span></div>`,
          `<span class="status"${status==='在售'?' data-status="good"':''}>${status}</span>`,details],
      };
    }).sort((a,b)=>Number(b.fields.status==='在售')-Number(a.fields.status==='在售'));
    return box('product-catalogue','商品目录',filterTable('catalogue',['商品','平台状态','SKU、价格与库存'],records,[
      {key:'query',label:'搜索商品',placeholder:'输入商品名、商品 ID 或 SKU'},
      {key:'status',label:'平台状态',options:[['','全部状态'],...[...new Set(records.map(item=>item.fields.status))].map(value=>[value,value])]},
    ],'没有符合筛选条件的商品。')+readback(catalogueSource));
  }

  function metricDeck(title, items) {
    const cards = items.map(({label,value,caption,icon,tone='gold',href})=>{
      const content = `<span class="workspace-metric-label">${glyph(symbols[icon] ?? symbols['today-tasks'])}${label}</span>
        <strong>${value}</strong>${caption ? `<small>${caption}</small>` : ''}`;
      return href ? `<a class="workspace-metric" href="${href}" data-tone="${tone}">${content}</a>`
        : `<div class="workspace-metric" data-tone="${tone}">${content}</div>`;
    });
    return `<div class="workspace-metrics" role="group" aria-label="${title}">${cards.join('')}</div>`;
  }

  function orderQueue(shipping) {
    const labels = {
      warehouse_sku_unverified:['仓库货号待核','按订单 SKU 核对仓库货号和可用库存'],
      stock_or_card_unverified:['库存或售后卡待核','核对库存、锁定件和随包售后卡'],
      warehouse_evidence_pending:['仓库回执待核','按原包裹回查发货仓和仓库回执'],
    };
    const rows = list(shipping?.rows).map(item=>{
      const route = routes[item.route] ?? '路线待核';
      const warehouse = warehouseName(item.warehouseId);
      const [status,next] = labels[item.state] ?? ['待发货','核对实际出库、包裹和承运商回执'];
      const inventories = list(item.inventory);
      const evidence = `<details class="row-receipt">
        <summary>查看订单凭证</summary>
        <dl class="row-facts"><div><dt>核对时间</dt><dd>${escape(stamp(item.evidenceAt))}</dd></div>
          <div><dt>下一步</dt><dd>${next}</dd></div>
          ${inventories.map(stock=>`<div><dt>${escape(warehouseName(stock.warehouseId))}</dt><dd>可发 ${number(stock.available)} · 锁定 ${number(stock.locked)}</dd></div>`).join('')}
        </dl>${readback(item.source)}</details>`;
      return {
        fields:{query:`${item.orderSuffix ?? ''} ${item.skuId ?? ''}`,route:item.route ?? 'unknown',warehouse:item.warehouseId ?? 'unknown'},
        columns:[`<b>${escape(item.orderSuffix ?? '待核')}</b>`,escape(item.skuId ?? '待核'),quantity(item.quantity,'件'),
          `<b>${escape(route)}</b><small>${escape(warehouse)}</small>`,`<span class="status">${status}</span>`,evidence],
      };
    });
    const explanation = '<p class="workspace-table-note">按待发订单的 SKU 明细展示。一单含多个 SKU 时会有多行，单量请看上方汇总。</p>';
    const body = rows.length ? filterTable('fulfillment',['订单尾号','SKU ID','数量','发货路线与仓库','目前进度','回查'],rows,[
      {key:'query',label:'找待发订单',placeholder:'输入订单尾号或 SKU ID'},
      {key:'route',label:'发货路线',options:[['','全部路线'],...Object.entries(routes),['unknown','路线待核']]},
      {key:'warehouse',label:'仓库',options:[['','全部仓库'],...warehouseOptions,['unknown','具体仓待核']]},
    ],'没有符合筛选条件的待发明细。',explanation) : blank(shipping?.pendingShipment===0
      ? '截至这次回查，平台待发货为 0 单。' : '当前快照暂无可展示的待发 SKU 明细。单量可见仓库汇总。');
    return box('fulfillment','待发订单明细',body+readback(shipping?.source),link('#warehouse-today','看仓库汇总'));
  }

  function orderWorkspace(data) {
    const shipping = data?.fulfillment;
    const totals = shipping?.liveTotals ?? shipping;
    const orderTime = totals ? `订单状态 ${escape(stamp(totals.source?.observedAt))}` : '';
    const unassigned = list(shipping?.warehouses).find(row=>row.warehouseId==='unassigned');
    return metricDeck('发货总览',[
      {label:'待发货',value:quantity(totals?.pendingShipment,'单'),caption:orderTime,icon:'fulfillment',href:'#fulfillment'},
      {label:'待揽收',value:quantity(totals?.awaitingCollection,'单'),caption:orderTime,icon:'fulfillment',tone:'green',href:'#warehouse-today'},
      {label:'待核仓库',value:quantity(unassigned?.pendingShipment,'单'),caption:shipping?.kind==='routing'
        ? `分仓回查 ${escape(stamp(shipping.source?.observedAt))}` : '等待分仓回查',icon:'warehouse-today',href:'#warehouse-today'},
    ])+warehousePriority(shipping)+orderQueue(shipping)+afterSalesPane(data?.afterSales,data?.day);
  }

  function listingReceipts(listing) {
    const confirmed = list(listing?.days).flatMap(day=>list(day.entries)).sort((a,b)=>
      String(b.verifiedAt).localeCompare(String(a.verifiedAt)));
    return box('listing-receipts','上架回执',confirmed.length ? filterTable('listing-receipts',
      ['商家 SKU','商品 ID','SKU ID','平台回查','确认在售时间'],confirmed.map(item=>({
        fields:{query:`${item.sellerSku} ${item.productId} ${item.skuId}`},
        columns:[`<b>${escape(item.sellerSku)}</b>`,escape(item.productId),escape(item.skuId),
          '<span class="status" data-status="good">确认在售</span>',escape(stamp(item.verifiedAt))],
      })),[{key:'query',label:'查上架回执',placeholder:'输入商家 SKU、商品 ID 或 SKU ID'}],
      '没有符合筛选条件的上架回执。')+foot(`${escape(listing.startDay)} 至 ${escape(listing.endDay)} · 创建与独立在售回执同时核实`)
      : blank('近四周暂无符合此口径的在售回执。'));
  }

  function pilotReceipt(pilot) {
    if (!pilot) return '';
    const states = { active:'生效中', ongoing:'生效中', expired:'已结束', ended:'已结束', up_to_date:'已回查' };
    return box('promotion-receipt','活动价格回查',`<dl class="row-facts activity-facts">
      ${[
        ['商家 SKU',escape(pilot.sellerSku ?? '待核')],
        ['活动 ID',escape(pilot.activityId ?? '待核')],
        ['平台活动状态',escape(states[pilot.state] ?? pilot.state ?? '待核')],
        ['常规价',money(pilot.regularPrice,pilot.currency)],
        ['活动价',money(pilot.price,pilot.currency)],
        ['活动限量',quantity(pilot.activityLimit,'件')],
        ['已用活动库存',quantity(pilot.used,'件')],
        ['已核活动订单明细',quantity(pilot.orderLines,'条')],
      ].map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
    </dl>`+readback(pilot.source));
  }

  function productWorkspace(data) {
    const catalogue = data?.shop?.catalogue;
    const ads = data?.promotion?.coverage;
    return metricDeck('商品总览',[
      {label:'在售商品',value:quantity(catalogue?.activeProducts,'款'),icon:'product-catalogue',href:'#product-catalogue',tone:'green'},
      {label:'目录商品',value:quantity(catalogue?.productsTotal,'款'),icon:'product-catalogue',href:'#product-catalogue'},
      {label:'进行中的活动',value:quantity(ads?.ongoingActivities,'项'),icon:'discount',href:'#discount'},
    ])+cataloguePane(catalogue)+split(promotionPane(data),rankedProducts(data))+
      pilotReceipt(data?.promotion?.pilot)+listingReceipts(data?.workflow?.listingHeatmap)+listingPane(data?.workflow?.listingHeatmap);
  }

  function publicationWorkspace(publication) {
    const deficit = count(publication?.progressCount) && count(publication?.target)
      ? Math.max(0,publication.target-publication.progressCount) : null;
    const displayProgress = count(publication?.progressCount)
      ? `${number(publication.progressCount)}${count(publication.target)?` / ${number(publication.target)} 条`:' 条'}` : '待核';
    return metricDeck('视频发布总览',[
      {label:'账本成功回执 / 今日目标',value:displayProgress,caption:publication?.platformCountComplete===true?'按今日发布账本与回查':'平台公开总数待核',icon:'publish-today',tone:'green',href:'#publish-today'},
      {label:'按账本还差',value:quantity(deficit,'条'),icon:'publish-today',href:'#publish-today'},
      {label:'公开和挂车待回查',value:quantity(publication?.pendingReadback,'条'),icon:'publish-review',href:'#publish-review'},
    ])+split(publishPriority(publication),publicationHistory(publication))+publicationPending(publication);
  }

  function shopWorkspace(data,showSales) {
    const sales = data?.shop?.sales;
    const snapshot = sales?.today;
    const activity = sales?.orderActivity?.day === data?.day ? sales.orderActivity : null;
    return metricDeck('店铺经营总览',[
      {label:'今日 GMV',value:money(snapshot?.gmv,snapshot?.currency ?? sales?.currency),caption:escape(stamp(snapshot?.source?.observedAt ?? snapshot?.observedAt ?? sales?.source?.observedAt)),icon:'sales-trend',href:'#daily-sales'},
      {label:activity?.paymentCoverage==='partial'?'今日已核支付订单':'今日支付订单',value:quantity(activity?.paidOrders ?? snapshot?.paidOrders,'单'),caption:activity ? `订单快照 ${escape(stamp(activity.source?.observedAt))}` : '',icon:'settlement',tone:'green',href:'#daily-sales'},
      {label:'今日买家实付',value:money(activity?.buyerPayment,activity?.currency),caption:activity ? '按订单快照汇总' : '',icon:'settlement',href:'#daily-sales'},
    ])+split(salesChart(sales),funnelPane(data))+
      `<div id="daily-sales">${split(showSales(),settlementPane(data?.finance))}</div>`+
      summaryPanel('service-status','店铺售后与客服',[
        ['待商家审核售后',quantity(data?.afterSales?.open?.pendingReturnRefund,'笔')],
        ['平台仲裁中',quantity(data?.afterSales?.open?.inArbitration,'笔')],
        ['未读会话',quantity(data?.afterSales?.inbox?.unreadConversations,'个')],
      ],`售后 ${escape(stamp(data?.afterSales?.open?.source?.observedAt))} · 客服 ${escape(stamp(data?.afterSales?.inbox?.source?.observedAt))}`,
      '/operations?tab=orders#after-sales');
  }

  function inventoryWorkspace(data) {
    const purchase = data?.procurement;
    const catalogue = data?.shop?.catalogue;
    const procurementTime = purchase?.source?.observedAt ? `采购回执 ${escape(stamp(purchase.source.observedAt))}` : '等待采购回执';
    return metricDeck('库存与供应总览',[
      {label:'采购草案待确认',value:quantity(purchase?.approvalCount,'项'),caption:procurementTime,icon:'stock-watch',href:'#procurement-tasks'},
      {label:'采购待办合计',value:quantity(purchase?.rows?.length,'项'),caption:procurementTime,icon:'today-tasks',href:'#stock-watch'},
      {label:'在售商品',value:quantity(catalogue?.activeProducts,'款'),caption:'目录中的库存为平台挂牌数',icon:'product-catalogue',tone:'green',
        href:'/operations?tab=products#product-catalogue'},
    ])+split(stockPane(purchase,12),roleQueue(data,'procurement-tasks','采购岗位任务','procurement'));
  }

  function syncPane(sync) {
    const state = sync?.running ? '正在取数' : sync?.error ? '上次取数未完成' :
      sync?.scheduled ? '按计划取数' : '待核';
    return summaryPanel('automation-progress','工作台取数进度',[
      ['当前状态',state],['上次尝试',escape(stamp(sync?.attemptedAt))],
      ['最近成功',escape(stamp(sync?.lastSuccessfulRun))],['下次取数',escape(stamp(sync?.nextAt))],
    ],escape(sync?.error || '此处显示店铺目录同步状态。'));
  }

  const homeTitle = '示例 TikTok 电商工作台';
  const pages = {
    shop:['店铺管理','经营数据、转化和结算',[
      ['sales-trend','成交趋势'],['conversion','转化漏斗'],['daily-sales','店铺日报'],['settlement','结算与利润'],['service-status','售后与客服'],
    ]],
    products:['商品管理','在售商品、销量、折扣和上架记录',[
      ['product-catalogue','商品目录'],['discount','折扣与活动'],['product-top','热卖商品'],['listing-receipts','上架回执'],['listing-heatmap','上架热力图'],
    ]],
    orders:['订单与发货','待发订单、仓库回执及售后',[
      ['warehouse-today','按仓发货'],['fulfillment','待发订单'],['after-sales','退款与客服'],
    ]],
    ads:['广告投流','GMV Max 花费、广告回报和计划',[
      ['ads','花费与回报'],['ad-campaigns','广告计划'],['ads-tasks','广告岗位任务'],
    ]],
    content:['内容运营','带货视频、账号流量和制作任务',[
      ['videos-more','带货排行'],['video-accounts','账号流量'],['production-tasks','视频制作任务'],
    ]],
    publishing:['账号发布','五个账号的进度及公开与商品卡回查',[
      ['publish-today','五账号进度'],['publication-history','近7日发布'],['publish-review','发布回查'],
    ]],
    inventory:['库存与供应','缺货核查和采购任务',[
      ['stock-watch','库存预警'],['procurement-tasks','采购任务'],
    ]],
    tasks:['任务与回执','今日待办和各岗位任务',[
      ['today-tasks','今日待办'],['role-tasks','岗位任务'],['automation-progress','取数进度'],
    ]],
  };
  const split = (first, second) => `<div class="workspace-page-split">${first}${second}</div>`;

  window.operationsDashboardPage = (data, {showSales,showAds,videos}) => {
    const requested = new URLSearchParams(location.search).get('tab');
    const page = Object.hasOwn(pages,requested) ? requested : 'overview';
    const settings = pages[page];
    document.body.dataset.workspacePage = page;
    document.querySelectorAll('[data-workspace-tab]').forEach(link=> {
      if (link.dataset.workspaceTab===page) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    });
    document.getElementById('workspace-title').textContent = settings?.[0] ?? homeTitle;
    document.getElementById('workspace-subtitle').textContent = settings?.[1] ?? '马来西亚玩具电商自动化工作空间';
    document.title = settings ? `${settings[0]} · ${homeTitle}` : homeTitle;
    if (!settings) return null;

    const publication = data?.workflow?.publication;
    const content = {
      shop: () => shopWorkspace(data,showSales),
      products: () => productWorkspace(data),
      orders: () => orderWorkspace(data),
      ads: () => showAds()+roleQueue(data,'ads-tasks','广告岗位任务','ads-analysis'),
      content: () => videos.more+roleQueue(data,'production-tasks','视频制作任务','video-production'),
      publishing: () => publicationWorkspace(publication),
      inventory: () => inventoryWorkspace(data),
      tasks: () => todayTasks(data)+split(roleQueue(data,'role-tasks','岗位任务'),syncPane(data?.sync)),
    };
    const sectionLinks = settings[2].map(([anchor,label])=>`<a href="#${anchor}">${label}</a>`).join('');
    return `<div class="workspace-page workspace-page--${page}"><nav class="workspace-jump" aria-label="本页内容">${sectionLinks}</nav>${content[page]()}</div>`;
  };

  window.renderOperationsDashboardDetail = data => {
    return `<div class="ops-lower"><h2 class="ops-lower-title">更多店铺数据</h2>
    ${publicationHistory(data?.workflow?.publication)}
    ${publicationPending(data?.workflow?.publication)}
    ${split(promotionPane(data),settlementPane(data?.finance))}
    ${listingPane(data?.workflow?.listingHeatmap)}</div>`;
  };
})();
