'use strict';

const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  tasks: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2m-6 9 2 2 4-4"/>',
  cart: '<path d="M2 4h3l2.6 11h10.7l2.7-8H6"/><circle cx="9" cy="19" r="1.4"/><circle cx="17.5" cy="19" r="1.4"/>',
  money: '<path d="m7 5 5 7 5-7m-5 7v8m-4-7h8m-8 3h8"/>',
  truck: '<path d="M3 6h12v11H3zM15 10h3l3 3v4h-6"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  publish: '<path d="M4 16v4h16v-4M12 15V4m-5 5 5-5 5 5"/>',
  warehouse: '<path d="m3 8 9-5 9 5v13H3V8Zm4 13V11h10v10m-10-6h10m-10 3h10"/>',
  growth: '<path d="M3 3v18h18M7 16l5-5 3 2 6-7m-5 0h5v5"/>',
  ads: '<path d="M3 11v3h4l11 5V6L7 11H3Zm4 3 2 7h3l-2-5m10-7 2-1m-2 8 2 1"/>',
  bag: '<path d="M4 7h16l1 13H3L4 7Zm4 0V6a4 4 0 1 1 8 0v1"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l7-7m0 0h3m-3 0V2"/>',
  videos: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>',
  legacy: '<path d="M13 4H4v16h16v-9M13 4h7v7m0-7-9 9"/>'
};
const icon = type => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[type]}</svg>`;
const tile = type => `<span class="icon-tile">${icon(type)}</span>`;
const host = document.getElementById('dashboard-content');
const banner = document.getElementById('dashboard-state');
const refreshed = document.getElementById('snapshot-date');
const refresh = document.getElementById('refresh');
const freshnessRows = document.getElementById('data-freshness-rows');
const lastLocalCheck = document.getElementById('last-local-check');
const freshnessPanel = document.getElementById('data-freshness');
const drawer = document.getElementById('details');
const malaysia = 'Asia/Kuala_Lumpur';
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:malaysia}).format(new Date());
const integer = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
const decimal = new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const time = new Intl.DateTimeFormat('zh-CN',{timeZone:malaysia,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const entries = new Map();
let dashboard;
let busy = false;
let hadFailure = false;
let adsPeriod = 'today';
let etag;
const refreshMillis = 15_000;
const clock = new Intl.DateTimeFormat('zh-CN',{timeZone:malaysia,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

const esc = value => String(value ?? '').replace(/[&<>"']/g,char=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const value = input => typeof input === 'string' && input.trim() ? esc(input) : '待核';
const amount = raw => {
  if (typeof raw !== 'number' && !(typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()))) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
};
const num = value => amount(value) === null ? '待核' : integer.format(amount(value));
const units = (value,unit) => amount(value) === null ? '待核' : `${num(value)} ${unit}`;
const cash = (value,currency) => amount(value) === null || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ? '待核' : `${currency === 'MYR' ? 'RM' : currency} ${decimal.format(amount(value))}`;
const ratio = value => amount(value) === null ? '待核' : `${decimal.format(amount(value))}×`;
const list = input => Array.isArray(input) ? input : [];
const dayOf = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0,10) : null;
const observed = source => source?.observedAt && Number.isFinite(Date.parse(source.observedAt)) ? new Date(source.observedAt) : null;
const localObservedDay = source => observed(source) ? new Intl.DateTimeFormat('sv-SE',{timeZone:malaysia}).format(observed(source)) : null;
const asOf = source => observed(source) ? time.format(observed(source)) : '读取时间待核';
const win = window => dayOf(window?.start) && dayOf(window?.endExclusive) ? `${dayOf(window.start)} 至 ${dayOf(window.endExclusive)} 前` : '统计区间待核';
function shortWindow(window) {
  if (!dayOf(window?.start) || !dayOf(window?.endExclusive)) return '最近完整区间';
  const last = new Date(Date.parse(window.endExclusive + 'T00:00:00Z') - 86400000).toISOString().slice(5,10);
  return window.start.slice(5,10).replace('-','/')+'–'+last.replace('-','/');
}

function status(label,tone='warn') {
  return `<span class="status" data-tone="${tone}">${esc(label)}</span>`;
}

function sourceLine(section,detail='',expect='daily') {
  const date = localObservedDay(section?.source);
  if (!section) return '<p class="source">暂无可用来源回执</p>';
  const lastDay = expect === 'complete' ? dayOf(section?.window?.endExclusive) : date;
  const stale = Boolean(lastDay && lastDay < today());
  const label = stale ? status('历史快照') : date ? status('有读取回执','ok') : status('来源时间待核');
  return `<p class="source">${label}${esc(asOf(section?.source))}${detail ? ` · ${esc(detail)}` : ''}</p>`;
}

function showFreshness(data) {
  const publication = data?.workflow?.publication;
  const sales = data?.shop?.sales;
  const salesCoverage = sales?.todayCoverage;
  const ranking = data?.videos?.ranking;
  const catalogue = data?.shop?.catalogue;
  const fulfillment = data?.fulfillment;
  const deliveryTotals = fulfillment?.liveTotals ?? fulfillment;
  const officialPublication = publication?.officialCoverage;
  const lastGmv = dayOf(salesCoverage?.latestAvailableDate ?? sales?.latestAvailableDate ?? list(sales?.series).at(-1)?.day);
  const gmvPending = amount(sales?.today?.gmv) === null && (salesCoverage?.state === 'report_pending' ||
    (!salesCoverage && lastGmv && lastGmv < today()));
  const lastPlatformVideos = dayOf(officialPublication?.latestAvailableDate);
  const specs = [
    ['支付订单与买家实付',sales?.orderActivity?.source,5,'每 5 分钟检查','/operations?tab=shop#daily-sales',data?.sync?.payments],
    ['官方 GMV',sales?.today?.source ?? salesCoverage?.source ?? sales?.source,30,amount(sales?.today?.gmv) === null
      ? lastGmv ? `平台目前出数到 ${lastGmv.slice(5)}` : '等待平台当天报表' : '平台当日累计',
    '/operations?tab=shop#daily-sales',data?.sync?.shopSales,gmvPending],
    ['待发货与待揽收',deliveryTotals?.source,5,fulfillment?.liveTotals ? '官方订单列表' : '订单原包裹回查',
      '/operations?tab=orders#fulfillment',data?.sync?.payments],
    ['各仓订单明细',fulfillment?.kind === 'routing' ? fulfillment.source : null,20,'按仓库和原包裹回查',
      '/operations?tab=orders#warehouse-today'],
    ['广告投流',data?.ads?.inProgress?.source,30,'GMV Max 当天累计','/operations?tab=ads#ads',data?.sync?.advertising],
    ['视频发布账本',{observedAt:publication?.localObservedAt},null,'按岗位成功回执','/operations?tab=publishing#publish-today'],
    ['视频公开回查',{observedAt:officialPublication?.observedAt ?? publication?.officialObservedAt},null,publication?.platformCountComplete
      ? '平台公开总数已回查' : lastPlatformVideos ? `公开总数待核 · 报表出数到 ${lastPlatformVideos.slice(5)}` : '平台公开总数待核',
    '/operations?tab=publishing#publish-review',null,officialPublication?.state==='report_date_lag'],
    ['商品目录',catalogue?.rowsSource ?? catalogue?.source,30,'官方分页商品目录','/operations?tab=products#product-catalogue'],
    ['视频表现',ranking?.source,null,shortWindow(ranking?.window),'/operations?tab=content#videos-more'],
    ['库存与采购',data?.procurement?.source,null,'按采购回执','/operations?tab=inventory#procurement-tasks'],
    ['结算',data?.finance?.source,null,'按账单回执','/operations?tab=shop#settlement'],
    ['售后与仲裁',data?.afterSales?.open?.source,null,'待商家处理退款、正在仲裁','/operations?tab=orders#after-sales'],
    ['客服未读',data?.afterSales?.inbox?.source,null,'按客服会话回执','/operations?tab=orders#after-sales'],
  ];
  freshnessRows.innerHTML=specs.map(([label,source,interval,note,href,collector,reportPending])=>{
    const date = observed(source);
    const min = date ? Math.max(0,Math.floor((Date.now()-date.getTime())/60_000)) : null;
    const late = interval !== null && min !== null && min > interval + 12;
    const checked = date ? `${asOf(source)}${min < 60 ? ` · ${min === 0 ? '刚刚' : min+' 分钟前'}` : ''}` : '尚无回执';
    const failureSource = Date.parse(collector?.observedAt);
    const unavailable = collector?.state === 'unavailable' &&
      (!date || !Number.isFinite(failureSource) || date.getTime() <= failureSource);
    const state = unavailable ? '取数待恢复' : reportPending ? '平台待出数' :
      collector?.state === 'outside_hours' ? '取数时段外' : date && localObservedDay(source) < today() ? '历史回执' :
      late ? '等待新回执' : date ? '有回执' : '待核';
    return `<a class="freshness-entry" href="${href}"><strong>${label}</strong>${status(state,state==='有回执'?'ok':'warn')}<span>${esc(checked)}</span><small>${esc(note)}</small></a>`;
  }).join('');
}

function empty(message) {
  return `<p class="empty">${esc(message)}</p>`;
}

function section(id,label,symbol,body,link='',accent=false) {
  return `<section class="panel${accent ? ' accent' : ''}" id="${id}" aria-labelledby="${id}-title"><header class="panel-head"><h2 id="${id}-title">${tile(symbol)}${label}</h2>${link}</header>${body}</section>`;
}

function readLink(text,target) {
  return `<a class="row-link" href="${target}">${text} ↗</a>`;
}

function readRow(id,title,caption,tail,facts,action='',thumbnail='') {
  entries.set(id,{ title,facts });
  const copy = `<span><strong>${esc(title)}</strong><span class="micro">${esc(caption)}</span>${action ? `<span class="step">${esc(action)}</span>` : ''}</span>`;
  const media = thumbnail ? `<span class="row-media">${thumbnail}${copy}</span>` : copy;
  return `<button class="row" data-entry="${id}">${media}<span class="number">${tail}</span></button>`;
}

function rawSourceFacts(source) {
  return [['读取时间',asOf(source)],['依据', source?.path ? String(source.path).split(/[\\/]/).filter(Boolean).pop() : '来源待核']];
}

function sparkBars(points) {
  const values = list(points).slice(-7).filter(point=>Number.isFinite(point) && point>=0);
  if (values.length<2 || Math.max(...values)===0) return '';
  const max = Math.max(...values);
  return `<svg viewBox="0 0 76 36" class="kpi-spark" aria-hidden="true">${values.map((point,i)=>{
    const height = Math.round(32*point/max);
    return `<rect x="${i*11}" y="${35-height}" width="7" height="${height}" rx="1" opacity="${(0.42+i*.09).toFixed(2)}"/>`;
  }).join('')}</svg>`;
}

function kpi(label,symbol,display,note,target,{tonal='orange',points=[],measure=''}={}) {
  const unknown = display==='待核' || display==='平台未出数';
  return `<a class="kpi" data-tone="${tonal}"${unknown?' data-unknown':''} href="${target}"><span class="kpi-label">${tile(symbol)}<span>${label}</span><strong class="kpi-value">${display}</strong></span><span class="kpi-note">${esc(note)}</span>${measure}<span class="kpi-mark">${sparkBars(points)}</span></a>`;
}

function suggestionsPane(items) {
  const rows=list(items).slice(0,6).map((item,index)=>readRow(`suggestion-${index}`,item.title || '待核经营事项',item.detail || '当前依据待核','<span class="arrow" aria-hidden="true">›</span>',[
    ['业务类型',item.kind],['关联商品',item.productId],['依据与原因',item.detail],['下一步',item.action],...rawSourceFacts(item.source)
  ],item.action));
  return section('suggestions','下一步怎么做','target',`<div class="panel-body rows">${rows.join('') || empty('当前快照没有已读取的建议条目。')}</div>`,readLink('任务中心','/operations?tab=tasks'),true);
}

function productDetails(ranking) {
  list(ranking?.rows).slice(0,6).forEach((row,index)=>{
    const image = typeof row.imageUrl==='string' && /^\/api\/operations\/dashboard\/images\/\d+\/cover$/u.test(row.imageUrl) ? row.imageUrl : null;
    entries.set(`product-${index}`,{title:row.title||'商品详情',image,facts:[
      ['商品 ID',row.productId],['统计区间',win(ranking.window)],['售出件数',num(row.itemsSold)],['实读订单',num(row.orders)],
      ['商品曝光',num(row.impressions)],['商品点击',num(row.clicks)],['退款件数',num(row.refundedItems)],...rawSourceFacts(ranking.source)
    ]});
  });
}

function adsSummary(data,label) {
  const metrics = [
    ['广告花费',cash(data?.spend,data?.currency),'money'],
    ['广告 ROI',ratio(data?.roi),'target'],
    ['归因销售额',cash(data?.grossRevenue,data?.currency),'growth'],
  ];
  return `<div class="mini-kpis ads-metrics" aria-label="${label}">${metrics.map(([title,metric,symbol])=>
    `<div>${tile(symbol)}<span>${title}</span><b>${metric==='待核'?'暂无报表':metric}</b></div>`).join('')}</div>`;
}

function adsTrend(complete) {
  const daily = list(complete?.series).filter(row=>dayOf(row.day) && amount(row.spend)!==null && amount(row.grossRevenue)!==null);
  if (daily.length < 2) return '';
  const max = Math.max(1,...daily.flatMap(row=>[amount(row.spend),amount(row.grossRevenue)]));
  const bar = (raw,label,kind,x) => {
    const height = Math.max(0,amount(raw))/max*46;
    return `<rect class="ads-bar ${kind}" x="${x}" y="${46-height}" width="7" height="${height}" rx="1.5"><title>${label} ${cash(raw,complete.currency)}</title></rect>`;
  };
  return `<div class="ads-trend"><div class="chart-legend"><span>归因销售额</span><span>广告费</span></div>
    <div class="ads-bars" role="list" aria-label="完整区间逐日广告费和归因销售额">${daily.map(row=>`<div class="ads-day" role="listitem" aria-label="${esc(row.day)}，广告费 ${cash(row.spend,complete.currency)}，归因销售额 ${cash(row.grossRevenue,complete.currency)}"><div><svg viewBox="0 0 20 46" aria-hidden="true">${bar(row.grossRevenue,'归因销售额','revenue',1)}${bar(row.spend,'广告费','spend',11)}</svg></div><time datetime="${esc(row.day)}">${esc(row.day.slice(5))}</time></div>`).join('')}</div>
  </div>`;
}

function adsPeriodControls() {
  return `<div class="ads-period" role="group" aria-label="广告统计时段"><button type="button" data-ads-period="today" aria-pressed="${adsPeriod==='today'}">今日</button><button type="button" data-ads-period="week" aria-pressed="${adsPeriod==='week'}">近 7 天</button></div>`;
}

function adsPeriodBody(data) {
  const week = adsPeriod==='week';
  const selected = week ? data?.complete : data?.inProgress;
  const title = week ? '近 7 个完整自然日' : '今日累计 · 马来西亚时间';
  const when = selected ? `${week?esc(shortWindow(selected.window)):'当日数据仍会更新'} · 读取于 ${esc(asOf(selected.source))}` :
    week ? '最近 7 天的完整报表尚未取得' : '今日报表尚未取得，可切换到近 7 天';
  return `<p class="ads-window"><strong>${title}</strong><span>${when}</span></p>
    ${adsSummary(selected,title)}
    ${week?adsTrend(selected):''}
    ${selected?`<p class="ads-attribution">归因订单 <strong>${units(selected.skuOrders,'单')}</strong><span>GMV Max 归因可能含自然成交</span></p>`:''}`;
}

function adsPane(data,{preview=false}={}) {
  const overview = `<div class="panel-body ads-body"><div data-ads-body aria-live="polite">${adsPeriodBody(data)}</div>
    ${preview?`<p class="ads-footer">${readLink('广告明细','/operations?tab=ads')}${readLink('广告岗位','/operations?tab=ads#ads-tasks')}</p>`:''}
  </div>`;
  const card = section('ads','广告投流','ads',overview,adsPeriodControls());
  if (preview) return card;
  const campaigns = list(data?.campaigns).slice(0,6).map((campaign,index)=>{
    const label = ({ENABLE:'投放开关开启',DISABLE:'投放开关关闭',PAUSED:'已暂停'})[campaign.status] || campaign.status || '计划状态待核';
    return readRow(`campaign-${index}`,campaign.name || '广告计划',label,cash(campaign.budget,campaign.currency),[
      ['计划 ID',campaign.id],['计划状态',label],['目标 ROAS',ratio(campaign.targetRoi)],['预算',cash(campaign.budget,campaign.currency)],['关联商品',list(campaign.productIds).join('、')],...rawSourceFacts(campaign.source)
    ]);
  });
  return card+section('ad-campaigns','广告计划','ads',`<div class="panel-body rows">${campaigns.join('') || empty('暂无可用的广告计划回执。')}</div>`,readLink('广告岗位','/operations?tab=ads#ads-tasks'));
}

function videoType(type) {
  return ({ALL:'全部账号',OFFICIAL_ACCOUNTS:'官方号',MARKETING_ACCOUNTS:'营销号',AFFILIATE_ACCOUNTS:'联盟账号'})[type] || type || '账号范围待核';
}

function videosPane(data) {
  const ranked = list(data?.ranking?.rows).slice(0,8).map((item,index)=>{
    const ads = item.ads;
    const media = item.media && item.media.playbackUrl === `/api/operations/dashboard/videos/${item.videoId}/clip` &&
      item.media.coverUrl === `/api/operations/dashboard/videos/${item.videoId}/cover` ? item.media : null;
    const label = ({'SN0092-Silver Gray SU57 Fighter Jet':'银灰 SU-57 桌拍','SN0092-F14 fighter':'F-14 桌拍','SN0092-Dark Green SU35 Fighter Jet':'深绿 SU-35 桌拍'})[item.label] || item.label || item.videoId || '视频数据';
    const support = `曝光 ${num(item.impressions)} · 点击 ${num(item.clicks)}`;
    const facts = [
      ['视频 ID',item.videoId],['账号',item.account],['商品 ID',item.productId],['SKU',item.skuId ?? media?.skuId],['商品曝光',num(item.impressions)],['商品点击',num(item.clicks)],['商品售出件数',num(item.unitsSold)],
      ['广告花费',cash(ads?.spend,ads?.currency)],['广告归因销售额',cash(ads?.grossRevenue,ads?.currency)],['广告归因订单',num(ads?.skuOrders)],['广告 ROAS',ratio(ads?.roi)],['广告归因口径',ads?.includesOrganic ? '平台归因包含自然成交' : null],['广告匹配状态',ads?.status],...rawSourceFacts(data?.ranking?.source)
    ];
    const length = Math.trunc(amount(media?.durationSeconds) ?? 0);
    const duration = length > 0 ? `<small class="clip-duration">▶ ${Math.floor(length/60)}:${String(length%60).padStart(2,'0')}</small>` : '';
    const thumbnail = media ? `<img class="row-thumb" alt="" src="${esc(media.coverUrl)}" loading="lazy" width="70" height="44">${duration}` : `<span class="row-thumb neutral-thumb" aria-hidden="true">${icon('videos')}</span>`;
    const platformUrl = /^\d{16,22}$/u.test(item.videoId ?? '') && /^[A-Za-z0-9._]{2,32}$/u.test(item.account ?? '') ?
      `https://www.tiktok.com/@${item.account}/video/${item.videoId}` : null;
    entries.set(`video-${index}`,{title:label,facts,media,platformUrl});
    const roi = amount(ads?.roi)===null ? '' : `<small class="video-roas" title="广告归因 ROAS">${ratio(ads.roi)}</small>`;
    return `<button class="video-rank row" data-entry="video-${index}" aria-label="${media?'播放':'查看'} ${esc(label)}"><span class="rank-chip">${index+1}</span><span class="video-covers">${thumbnail}</span><span class="video-rank-copy"><strong title="${esc(label)}">${esc(label)}</strong><small>${esc(support)}</small></span><span class="number">${units(item.unitsSold,'件')}${roi}</span></button>`;
  });
  const body=`<div class="panel-body"><div class="video-ranking">${ranked.slice(0,3).join('') || empty('等待视频商品表现回执。')}</div><p class="row-video-source">${esc(shortWindow(data?.ranking?.window))} · 商品售出件数排名</p></div>`;
  const accountRows = list(data?.overview?.rows).map(row=>`<tr><td>${esc(videoType(row.accountType))}</td><td>${num(row.impressions)}</td><td>${num(row.clicks)}</td><td>${units(row.skuOrders,'单')}</td><td>${cash(row.gmv,data?.overview?.currency)}</td></tr>`);
  const more=`<div class="grid secondary-grid video-detail-grid">
    ${section('videos-more','视频商品详细排行','videos',`<div class="panel-body video-ranking">${ranked.join('') || empty('等待视频商品表现回执。')}</div>${sourceLine(data?.ranking,win(data?.ranking?.window),'complete')}`)}
    ${section('video-accounts','视频带货数据','videos',`<div class="panel-body"><div class="table-wrap"><table><thead><tr><th scope="col">账号类型</th><th scope="col">商品曝光</th><th scope="col">点击</th><th scope="col">归因单</th><th scope="col">成交额</th></tr></thead><tbody>${accountRows.join('')}</tbody></table></div>${accountRows.length?'':empty('等待分账号视频数据。')}</div>${sourceLine(data?.overview,data?.overview?.day)}`,readLink('发布回执','/operations?tab=publishing#publish-review'))}
  </div>`;
  return { preview:section('videos','表现好的视频 TOP3','videos',body,readLink('看详细排行','/operations?tab=content#videos-more')), more };
}

function salesPane(shop) {
  const sales = shop?.sales;
  const catalogue = shop?.catalogue;
  const records = list(sales?.series).filter(row=>dayOf(row.day)).sort((a,b)=>b.day.localeCompare(a.day)).slice(0,7).map(row=>`<tr><td>${value(row.day)}</td><td>${cash(row.gmv,sales.currency)}</td><td>${num(row.orders)}</td></tr>`);
  const trend = records.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">日期</th><th scope="col">GMV</th><th scope="col">订单量</th></tr></thead><tbody>${records.join('')}</tbody></table></div>` : empty('没有可用的分日成交明细。');
  const orderNote = amount(catalogue?.orders7d) !== null
    ? `<p class="micro">近 7 日订单 ${num(catalogue.orders7d)} 单 · ${esc(asOf(catalogue.source))}</p>` : '';
  const body=`<div class="panel-body"><div class="mini-kpis"><div><span>GMV</span><b>${cash(sales?.gmv,sales?.currency)}</b></div><div><span>视频 GMV</span><b>${cash(sales?.videoGmv,sales?.currency)}</b></div><div><span>在售商品</span><b>${num(catalogue?.activeProducts)}</b></div></div>${trend}<div class="links">${readLink('库存补货','/operations?tab=inventory')}${readLink('商品与促销','/operations?tab=products#discount')}</div></div>${sourceLine(sales,win(sales?.window),'complete')}<div class="panel-body"><p class="micro">商品目录 · 在售 ${num(catalogue?.activeProducts)} / ${num(catalogue?.productsTotal)} 款</p>${orderNote}</div>${sourceLine(catalogue && {source:catalogue.countsSource ?? catalogue.source})}`;
  return section('sales','经营与商品','growth',body);
}

function render(data) {
  const shop = data?.shop;
  const sales = shop?.sales;
  const shipping = data?.fulfillment;
  const shippingTotals = shipping?.liveTotals ?? shipping;
  const snapshot = data ?? {};
  const publication = snapshot.workflow?.publication;
  const todaySales = sales?.today;
  const orderActivity = sales?.orderActivity?.day === snapshot.day ? sales.orderActivity : null;
  const target = amount(publication?.target);
  const platformComplete = publication?.platformCountComplete === true;
  const published = amount(platformComplete ? publication?.officialCount : publication?.progressCount);
  const lastSales = list(sales?.series).at(-1);
  const progress = target > 0 && published !== null ? `<progress class="kpi-progress" value="${Math.min(target,published)}" max="${target}" aria-label="今日发布成功回执"></progress>` : '';
  entries.clear();
  productDetails(data?.productRank);
  const videos = videosPane(data?.videos);
  const route = window.operationsDashboardPage?.(snapshot,{
    showSales:()=>salesPane(shop), showAds:()=>adsPane(data?.ads), videos,
  });
  refreshed.textContent = dayOf(data?.day) || '快照日期待核';
  if (route) {
    host.innerHTML = route;
    return;
  }
  const stats=[
    kpi('今日 GMV','money',amount(todaySales?.gmv)!==null ? cash(todaySales.gmv,sales?.currency) : '平台未出数',
      amount(todaySales?.gmv)!==null ? `平台当日累计 · ${asOf(todaySales.source ?? sales.source)}` :
        amount(orderActivity?.buyerPayment)!==null ? `今日买家实付 ${cash(orderActivity.buyerPayment,orderActivity.currency)}` :
          lastSales ? `上次完整日 ${lastSales.day.slice(5)} · ${cash(lastSales.gmv,sales.currency)}` : '平台尚未返回今日 GMV','/operations?tab=shop#sales-trend',
      {points:list(sales?.series).map(row=>amount(row.gmv))}),
    kpi(orderActivity?.paymentCoverage==='partial'?'今日已核支付订单':'今日支付订单','tasks',units(orderActivity?.paidOrders,'单'),
      amount(orderActivity?.paidOrders)!==null ? `按支付时间 · ${asOf(orderActivity.source)}` : '等待含支付时间的订单回执','/operations?tab=shop#daily-sales',
      {points:list(sales?.series).map(row=>amount(row.orders))}),
    kpi('今日发布进度','publish',target===null || published===null ? units(published,'条') : `${num(published)} / ${num(target)} 条`,
      platformComplete ? `平台公开发布 · ${asOf({observedAt:publication.officialObservedAt})}` :
        published===null ? '今天的平台公开数量待核' :
          `发布账本 · ${asOf({observedAt:publication.localObservedAt})} · 平台待核`,'/operations?tab=publishing',
      {tonal:'green',points:list(publication?.trend).map(row=>amount(row.progressCount)),measure:progress}),
    kpi(shippingTotals?.isCurrentDay===false?'待发货 · 上次回查':'待发货','truck',units(shippingTotals?.pendingShipment,'单'),
      shippingTotals ? `待揽收 ${units(shippingTotals.awaitingCollection,'单')} · ${asOf(shippingTotals.source)}` : '尚无可用订单快照','/operations?tab=orders')
  ];
  const analysisSuggestions = list(data?.suggestions).filter(item => item.kind !== 'fulfillment' && item.kind !== 'procurement');
  host.innerHTML=`<div class="kpis overview-kpis">${stats.join('')}</div>
    ${window.renderOperationsDashboardSummary(snapshot,adsPane(data?.ads,{preview:true}))}
    ${window.renderOperationsDashboardTasks(snapshot)}
    ${window.renderOperationsDashboardAnalysis(snapshot)}
    ${window.renderOperationsDashboardMedia(snapshot,videos.preview)}
    <div class="grid secondary-grid analysis-row">${suggestionsPane(analysisSuggestions)}${salesPane(shop)}</div>
    ${window.renderOperationsDashboardDetail(snapshot)}`;
}

function updateBanner(message,tone='warn') {
  if (banner.textContent !== message) banner.textContent = message;
  banner.dataset.tone = tone;
}

function updateLocalCheck(data) {
  lastLocalCheck.textContent = `页面查阅 ${clock.format(new Date())}`;
  if (freshnessPanel.open) showFreshness(data);
}

function showDetail(key) {
  const entry = entries.get(key);
  if (!entry) return;
  document.getElementById('detail-title').textContent=entry.title;
  const external = entry.platformUrl ? `<a class="button" href="${esc(entry.platformUrl)}" target="_blank" rel="noopener noreferrer">打开 TikTok 原帖 ↗</a>` : '';
  const media = entry.media ? `<div class="detail-video"><video controls playsinline preload="metadata" poster="${esc(entry.media.coverUrl)}" src="${esc(entry.media.playbackUrl)}" aria-label="${esc(entry.title)}"></video><div class="video-actions"><a class="button primary" href="${esc(entry.media.playbackUrl)}?download=1" download>下载原片</a>${external}</div></div>` :
    entry.image ? `<img class="detail-product" src="${esc(entry.image)}" alt="${esc(entry.title)}">` : external ? `<p class="video-actions">${external}</p>` : '';
  drawer.classList.toggle('with-media',Boolean(entry.media||entry.image));
  document.getElementById('detail-content').innerHTML=`<div class="evidence-layout">${media}<dl>${entry.facts.map(([label,input])=>`<div><dt>${esc(label)}</dt><dd>${input === undefined || input === null || input === '' ? '待核' : esc(input)}</dd></div>`).join('')}</dl></div>`;
  drawer.showModal();
}

async function load() {
  if (busy) return;
  busy = true;
  try {
    const headers={Accept:'application/json'};
    if (etag && dashboard) headers['If-None-Match']=etag;
    const response = await fetch('/api/operations/dashboard',{cache:'no-store',headers,signal:AbortSignal.timeout(25000)});
    if (response.status===304 && dashboard) {
      updateLocalCheck(dashboard);
      if (hadFailure) updateDashboardBanner(dashboard);
      hadFailure = false;
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || typeof data !== 'object' || !Object.hasOwn(data,'shop') || !Object.hasOwn(data,'day')) throw new Error('不完整的快照结构');
    const changed = !dashboard || JSON.stringify(dashboard) !== JSON.stringify(data);
    if (changed || hadFailure) renderWithFocus(data);
    if (!dashboard && location.hash) requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView());
    dashboard = data;
    etag = response.headers.get('etag');
    updateLocalCheck(data);
    if (exportButton) exportButton.disabled = false;
    hadFailure = false;
    updateDashboardBanner(data);
  } catch {
    hadFailure = true;
    if (dashboard) updateBanner('本次读取失败，保留上次成功取得的快照。请核对各卡片的数据时间。','error');
    else {
      render(null);
      updateBanner('暂时无法读取本地业务数据。','error');
    }
  } finally {
    busy = false;
    host.setAttribute('aria-busy','false');
  }
}

function updateDashboardBanner(data) {
  if (!dayOf(data.day) || dayOf(data.day) < today()) updateBanner('历史快照 · 各卡片显示各自的更新时间。');
  else if (data.sync?.running || list(data.sync?.activeReads).length) updateBanner('后台正在检查数据源。','ok');
  else if (data.sync?.error) updateBanner('店铺目录同步待恢复 · 其他数据按各自回执显示。');
  else updateBanner('页面每 15 秒查阅回执 · 查看各数据源时间','ok');
}

function renderWithFocus(data) {
  const active = document.activeElement;
  const filter = active?.closest('[data-filter-table]')?.dataset.filterTable;
  const key = active?.dataset.filterKey;
  const period = active?.dataset.adsPeriod;
  const selection = active?.type==='search' ? [active.selectionStart,active.selectionEnd] : null;
  render(data);
  const controls = filter && key ? host.querySelectorAll('[data-filter-key]') : period ? host.querySelectorAll('[data-ads-period]') : [];
  const restored = [...controls].find(element => filter && key
    ? element.dataset.filterKey===key && element.closest('[data-filter-table]')?.dataset.filterTable===filter
    : element.dataset.adsPeriod===period);
  restored?.focus({preventScroll:true});
  if (selection && restored?.type==='search') restored.setSelectionRange(...selection);
}

async function requestRefresh() {
  refresh.disabled = true;
  try {
    const response = await fetch('/api/operations/dashboard/refresh',{
      method:'POST',signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'},
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const {accepted} = await response.json();
    await load();
    if (!hadFailure) {
      const message = accepted ? '已请求后台取数，可查看各项更新时间。' :
        dashboard?.sync?.scheduled === false ? '此服务只显示已保存的回执。' : '后台正在取数或刚检查过，请稍候。';
      updateBanner(message, accepted ? 'ok' : 'warn');
    }
  } catch {
    await load();
    updateBanner('暂时无法请求后台取数，正在查阅已有回执。');
  } finally {
    refresh.disabled = false;
  }
}

document.querySelectorAll('[data-icon]').forEach(link=>link.insertAdjacentHTML('afterbegin',icon(link.dataset.icon)));
host.addEventListener('click',event=>{
  const period = event.target.closest('button[data-ads-period]');
  if (period) {
    adsPeriod = period.dataset.adsPeriod;
    host.querySelector('[data-ads-body]').innerHTML = adsPeriodBody(dashboard?.ads);
    host.querySelectorAll('button[data-ads-period]').forEach(el=>el.setAttribute('aria-pressed',String(el===period)));
    return;
  }
  const button = event.target.closest('button[data-entry]');
  if (button) showDetail(button.dataset.entry);
});
host.addEventListener('error',event=>{
  if (event.target.matches('img.row-thumb')) event.target.outerHTML=`<span class="row-thumb neutral-thumb" aria-hidden="true">${icon('videos')}</span>`;
},true);
drawer.addEventListener('click',event=>{ if (event.target === drawer) drawer.close(); });
drawer.addEventListener('close',()=>drawer.querySelector('video')?.pause());
refresh.addEventListener('click',requestRefresh);
freshnessPanel.addEventListener('toggle',()=>{ if (freshnessPanel.open) showFreshness(dashboard); });
const exportButton = document.getElementById('export-dashboard');
if (exportButton) {
  exportButton.disabled = true;
  exportButton.addEventListener('click', () => {
    if (!dashboard) return;
    const payload = new Blob([JSON.stringify(dashboard,null,2)+'\n'],{type:'application/json'});
    const url = URL.createObjectURL(payload);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `MY-店铺报表-${dayOf(dashboard.day) || '快照'}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  });
}
load();
setInterval(()=>{ if (document.visibilityState === 'visible') load(); },refreshMillis);
document.addEventListener('visibilitychange',()=>{ if (document.visibilityState === 'visible') load(); });
