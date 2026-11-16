const byId = id => document.getElementById(id);
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Kuala_Lumpur', month: 'numeric',
  day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const stamp = value => Number.isFinite(Date.parse(value)) ? time.format(new Date(value)) : '待核';
const number = value => Number.isSafeInteger(value) ? value.toLocaleString('zh-CN') : '待核';
const dashboardNumber = value => Number.isSafeInteger(value) ? value.toLocaleString('zh-CN') : '—';
const roleNames = new Map([
  ['procurement', '采购备货'], ['video-production', '视频制作'],
  ['video-publishing', '视频发布'], ['ads-analysis', '广告分析'],
]);
const queueRolesByModule = new Map([
  ['fulfillment', 'procurement'], ['production', 'video-production'], ['publishing', 'video-publishing'], ['ads', 'ads-analysis'],
]);
const runModules = new Map([['replenishment', '备货建议'], ['creative', '好视频分析']]);
const runLabelsByState = new Map([['running', ['读取中', 'info']], ['retry', ['等待读取重试', 'warn']], ['done', ['只读分析完成', 'ok']]]);
const taskGroups = [
  ['queued', '今天该做', '暂无待处理任务'],
  ['retry', '等待复验', '暂无待重试或复验任务'],
  ['approval', '需大磊决策', '暂无待确认任务'],
];
const node = (tag, className, content) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
};

function chip(text, style) {
  return node('span', 'chip ' + style, text);
}

const roleHref = role => '/operations' + (role ? '?role=' + encodeURIComponent(role) : '') + '#tasks';

function selectedRole() {
  const value = new URLSearchParams(location.search).get('role');
  return roleNames.has(value) ? value : null;
}

function markLocation() {
  const hash = location.hash || '#workspace';
  const role = selectedRole();
  document.querySelectorAll('.navigation a').forEach(link => {
    if (link.hash === hash && (!link.hasAttribute('data-role-link') || role === 'procurement') &&
      !(link.hash === '#tasks' && !link.hasAttribute('data-role-link') && role === 'procurement')) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  const selected = roleHref(selectedRole());
  document.querySelectorAll('#role-links a').forEach(link => {
    if (link.getAttribute('href') === selected) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
}

function renderMetrics(metrics, day) {
  const todayOrders = metrics?.trend.find(row => row.day === day)?.count;
  const figures = [
    ['今日下单', todayOrders, '含各订单状态'],
    ['近 7 天订单', metrics?.orders7d, '滚动 168 小时'],
    ['在售商品', metrics?.activeProducts, 'TikTok Shop 商品状态'],
    ['待发货', metrics?.awaitingShipment, `近 7 天 · 待揽收 ${number(metrics?.awaitingCollection)}`],
  ];
  byId('metrics').replaceChildren(...figures.map(([label, value, hint]) => {
    const item = node('div', 'metric');
    item.append(node('span', 'metric-label', label), node('strong', '', number(value)), node('small', '', hint));
    return item;
  }));
  const trend = metrics?.trend ?? [];
  const max = Math.max(1, ...trend.map(row => row.count));
  byId('chart').replaceChildren(...trend.map(({ day: chartDay, count }) => {
    const row = node('div', 'chart-row');
    const bar = node('meter');
    bar.max = max;
    bar.value = count;
    bar.setAttribute('aria-label', `${chartDay} 下单 ${count} 笔`);
    row.append(node('span', '', chartDay.slice(5)), bar, node('strong', '', number(count)));
    return row;
  }));
  byId('chart-note').textContent = metrics ? `统计截至 ${stamp(metrics.collectedAt)}。今日数据会随下一轮读取更新。` : '店铺数据读取后会显示每日订单。';
}

function renderAttention(current) {
  const { modules, promotion, metrics } = current;
  const find = id => modules.find(row => row.id === id);
  const notes = [
    ['活动与折扣', find('promotion').result],
    ['发货待核', metrics ? `${find('fulfillment').result} 下一步核对归属仓库。` : find('fulfillment').result],
    ['视频发布', find('publishing').result],
  ];
  if (promotion?.state === 'verified' && promotion.priority?.length) {
    notes.splice(1, 0, ['优先核折扣', `${promotion.priority.map(row => row.label).join('、')}。${
      Number.isSafeInteger(promotion.uncoveredWithCosts) ? `未匹配活动的商品中有 ${promotion.uncoveredWithCosts} 款可对上 SKU 成本台账，下一步核现行费用和活动门槛。` : ''}`]);
  }
  byId('attention').replaceChildren(...notes.map(([label, detail]) => {
    const item = node('li');
    item.append(node('strong', '', label), node('span', '', detail));
    return item;
  }));
  const candidates = promotion?.toReview ?? [];
  byId('promo-details').hidden = !candidates.length;
  byId('promo-title').textContent = `查看 ${number(candidates.length)} 款待核商品`;
  byId('promo-note').textContent = `商家活动关系截至 ${stamp(promotion?.checkedAt)}。平台官方报名、店铺券和成交价需分别核对。`;
  byId('promo-items').replaceChildren(...candidates.map(row => {
    const relationship = row.coverage === 'none' ? '未匹配商家活动' : row.coverage === 'some' ?
      `${row.coveredSkus}/${row.skuCount} 个 SKU 已匹配` : 'SKU 关系待回查';
    const cost = Number.isSafeInteger(row.costMatchedSkus) ?
      (row.costMatchedSkus ? ` · ${row.costMatchedSkus} 个 SKU 已匹配成本台账` : ' · 成本台账待匹配') : '';
    return node('li', '', `${row.title || '商品标题待核'} · ${relationship}${cost}`);
  }));
}

const scheduleLabels = {
  board: ['面板定时取数', 'ok'], enabled: ['定时运行已启用', 'info'], paused: ['定时运行已暂停', 'warn'],
};
const runLabels = { started: '会话开始，结束待核', ended: '最近会话已结束', interrupted: '最近会话已中断' };

function renderModules(modules) {
  byId('modules').replaceChildren(...modules.map(role => {
    const row = node('div', 'module-row');
    row.setAttribute('role', 'row');
    const name = node('div');
    const scheduled = node('div');
    const result = node('div', 'module-result');
    const next = node('div', 'module-next', role.next);
    name.append(node('strong', '', role.name), node('small', '', role.source));
    const queueRole = queueRolesByModule.get(role.id);
    if (queueRole) {
      const tasks = node('a', 'text-link', '查看任务');
      tasks.href = roleHref(queueRole);
      tasks.dataset.roleLink = '';
      tasks.setAttribute('aria-label', `查看${roleNames.get(queueRole)}任务`);
      name.append(tasks);
    }
    scheduled.append(chip(...(scheduleLabels[role.schedule] ?? ['排程待核', 'muted'])));
    const runLabel = role.schedule === 'enabled' && role.run?.state === 'ended'
      ? '上轮已结束，等待下次触发' : runLabels[role.run?.state];
    if (runLabel) {
      const trigger = role.run.trigger === 'automation_heartbeat_scheduled' ? '定时触发 · ' : '';
      scheduled.append(node('small', '', `${trigger}${runLabel} · ${stamp(role.run.at)}`));
    }
    result.append(node('span', '', role.result));
    if (role.link?.url && role.link.title) {
      const url = URL.parse(role.link.url);
      if (url?.protocol === 'https:' && ['www.tiktok.com', 'shop.tiktok.com', 'vt.tiktok.com'].includes(url.host) &&
          !url.username && !url.password) {
        const link = node('a', '', role.link.title);
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        result.append(link);
      }
    }
    if (role.at) result.append(node('small', '', '回执 ' + stamp(role.at)));
    for (const cell of [name, scheduled, result, next]) cell.setAttribute('role', 'cell');
    row.append(name, scheduled, result, next);
    return row;
  }));
}

function queueRow({ module, key, role, title, detail, priority, firstDay, lastDay, sourceRef }) {
  const item = node('li', 'task-item');
  const record = node('details');
  record.dataset.key = `${module}:${key}`;
  const summary = node('summary');
  const heading = node('span', 'task-name', title);
  const meta = node('span', 'task-meta');
  if (priority === 'urgent') meta.append(chip('优先', 'warn'));
  meta.append(node('span', '', roleNames.get(role) ?? role));
  if (lastDay) meta.append(node('time', '', lastDay));
  summary.append(heading, meta);
  record.append(summary);
  const content = node('div', 'task-details');
  if (typeof detail === 'string' && detail) content.append(node('p', '', detail));
  if (detail && typeof detail === 'object') {
    if (detail.action) content.append(node('p', '', detail.action));
    if (detail.comparison) content.append(node('p', '', detail.comparison));
    const identity = [['账号', detail.account], ['视频', detail.videoId], ['商品', detail.productId], ['SKU', detail.sellerSku ?? detail.skuId]]
      .filter(([, value]) => value).map(([label, value]) => `${label} ${value}`);
    if (identity.length) content.append(node('p', 'note', identity.join(' · ')));
    const ads = detail.currentAds;
    if (ads?.window?.start && ads.window.end && Number.isSafeInteger(ads.skuOrders)) {
      const spend = ads.spend != null && ads.currency ? ` · 花费 ${ads.currency} ${ads.spend}` : '';
      content.append(node('p', 'note', `GMV Max ${ads.window.start} 至 ${ads.window.end} · 归因 ${ads.skuOrders} 单${spend}`));
    }
    if (detail.currentShopAvailability?.latestAvailableDate) {
      content.append(node('p', 'note', `店铺视频数据截至 ${detail.currentShopAvailability.latestAvailableDate}`));
    }
    const evidence = node('details', 'record-data');
    evidence.append(node('summary', '', '查看原始字段'), node('pre', 'detail-data', JSON.stringify(detail, null, 2)));
    content.append(evidence);
  }
  if (firstDay && firstDay !== lastDay) content.append(node('p', 'note', `首次记录 ${firstDay}`));
  if (sourceRef) content.append(node('p', 'source-ref', `本地回执 · ${sourceRef}`));
  record.append(content);
  item.append(record);
  return item;
}

function runSummary(module, summary) {
  if (typeof summary === 'string') return summary;
  if (!summary || typeof summary !== 'object') return '';
  if (module === 'replenishment') {
    return [
      Number.isSafeInteger(summary.domesticPaidOrders) && `国内直发 ${summary.domesticPaidOrders} 单`,
      Number.isSafeInteger(summary.recommendationCount) && `建议 ${summary.recommendationCount} 项`,
      Number.isSafeInteger(summary.urgentCount) && `优先 ${summary.urgentCount} 项`,
    ].filter(Boolean).join(' · ');
  }
  return [
    Number.isSafeInteger(summary.proposed) && `建议 ${summary.proposed} 项`,
    Array.isArray(summary.proposed) && `建议 ${summary.proposed.length} 项`,
    Number.isSafeInteger(summary.reusedHandoffs) && `复用 ${summary.reusedHandoffs} 项`,
    Array.isArray(summary.reusedHandoffs) && `复用 ${summary.reusedHandoffs.length} 项`,
    Number.isSafeInteger(summary.waitingForSameWindow) && `待补同窗证据 ${summary.waitingForSameWindow} 项`,
  ].filter(Boolean).join(' · ');
}

function taskGroupState(task) {
  if (task.state === 'queued' && task.role === 'ads-analysis' && task.detail?.completeCrossSourceEvidence === null) return 'retry';
  return task.state;
}

function renderQueue(queue, role) {
  const list = byId('queue-runs');
  const groups = byId('task-groups');
  const openRunSources = new Set([...list.querySelectorAll('.run-sources[open]')].map(item => item.dataset.module));
  const latest = new Map();
  for (const run of queue.runs) {
    if (!latest.has(run.module) || (run.day ?? '') > (latest.get(run.module).day ?? '')) latest.set(run.module, run);
  }
  list.replaceChildren(...Array.from(runModules, ([module, label]) => {
    const run = latest.get(module);
    const item = node('li', 'queue-run');
    const heading = node('div', 'run-heading');
    heading.append(node('strong', '', label), chip(...(runLabelsByState.get(run?.state) ?? ['暂无回执', 'muted'])));
    item.append(heading);
    if (run) {
      item.append(node('p', 'note', `${run.day} · 第 ${number(run.attempts)} 次 · 更新 ${stamp(run.updatedAt)}`));
      if (run.state === 'retry' && run.nextRunAt) item.append(node('p', 'note', `下次尝试 ${stamp(run.nextRunAt)}`));
      if (run.error) item.append(node('p', 'run-error', run.error));
      const summary = runSummary(module, run.summary);
      if (summary) item.append(node('p', 'run-summary', summary));
      const sources = [...new Set([run.summary?.receipt, ...(run.sources ?? [])].filter(ref => typeof ref === 'string' && ref))];
      if (sources.length) {
        const receipts = node('details', 'run-sources');
        receipts.dataset.module = module;
        receipts.open = openRunSources.has(module);
        const references = node('ul', 'source-ref');
        references.append(...sources.map(ref => node('li', '', ref)));
        receipts.append(node('summary', '', `查看 ${number(sources.length)} 份本地回执`), references);
        item.append(receipts);
      }
    }
    return item;
  }));
  const open = new Set([...groups.querySelectorAll('details[data-key][open]')].map(item => item.dataset.key));
  const expanded = new Set([...groups.querySelectorAll('.more-tasks[open]')].map(item => item.dataset.state));
  const tasks = queue.tasks.filter(task => !role || role === task.role);
  const runRetries = [...latest.values()].filter(run => run.state === 'retry' &&
    (!role || (run.module === 'replenishment' ? role === 'procurement' : role !== 'procurement')));
  groups.replaceChildren(...taskGroups.map(([state, label, empty]) => {
    const group = node('section', 'task-group');
    group.dataset.state = state;
    const rows = tasks.filter(task => taskGroupState(task) === state).map(queueRow);
    if (state === 'retry') {
      rows.push(...runRetries.map(run => {
        const item = node('li', 'task-item retry-item');
        item.append(node('span', 'task-name', runModules.get(run.module)),
          node('span', 'note', run.nextRunAt ? `重试 ${stamp(run.nextRunAt)}` : '重试时间待核'));
        return item;
      }));
    }
    const heading = node('h3', 'group-heading', label);
    heading.append(node('span', 'group-count', rows.length));
    group.append(heading);
    if (rows.length) {
      for (const row of rows) {
        const record = row.querySelector('details');
        if (record && open.has(record.dataset.key)) record.open = true;
      }
      const body = node('div', 'group-body');
      const items = node('ul', 'task-items');
      const previewCount = 5;
      items.append(...rows.slice(0, previewCount));
      body.append(items);
      if (rows.length > previewCount) {
        const more = node('details', 'more-tasks');
        more.dataset.state = state;
        more.open = expanded.has(state);
        const extra = node('ul', 'task-items');
        extra.append(...rows.slice(previewCount));
        more.append(node('summary', '', `其余 ${number(rows.length - previewCount)} 项任务`), extra);
        body.append(more);
      }
      group.append(body);
    } else {
      group.append(node('p', 'group-empty', empty));
    }
    return group;
  }));
  byId('queue-time').textContent = queue.updatedAt ? `台账更新 ${stamp(queue.updatedAt)}` : '';
}

async function refreshQueueMetrics() {
  try {
    const response = await fetch('/api/operations/tasks', { cache: 'no-store' });
    if (!response.ok) return;
    const queue = await response.json();
    const replenishment = queue.tasks.filter(item => item.role === 'procurement' && item.state === 'approval').length;
    const latestRuns = new Map();
    for (const run of queue.runs) {
      if (!latestRuns.has(run.module) || run.day > latestRuns.get(run.module).day) latestRuns.set(run.module, run);
    }
    const retries = [...latestRuns.values()].filter(item => item.state === 'retry').length +
      queue.tasks.filter(item => taskGroupState(item) === 'retry').length;
    const available = latestRuns.get('replenishment')?.state === 'done' || replenishment > 0;
    const stock = available ? replenishment : null;
    byId('kpi-replenishment').textContent = dashboardNumber(stock);
    byId('quick-replenishment').textContent = dashboardNumber(stock);
    byId('priority-replenishment').textContent = stock == null ? '补货草案待核' : `${stock} 项补货待确认`;
    byId('quick-retry').textContent = dashboardNumber(queue.updatedAt ? retries : null);
  } catch {
    // The task panel reports availability separately on a failed local read.
  }
}

function renderReport(report) {
  const reportTime = byId('report-time');
  const list = byId('report-list');
  const summary = byId('report-metrics');
  if (!report) {
    reportTime.textContent = '该日还没有日报记录。';
    summary.replaceChildren();
    list.replaceChildren();
    return;
  }
  reportTime.textContent = report.metrics ? `店铺取数截至 ${stamp(report.metrics.collectedAt)}` : '店铺取数待核';
  const todayOrders = report.metrics?.trend.find(row => row.day === report.day)?.count;
  summary.replaceChildren(
    chip(`当日下单 ${number(todayOrders)}`, 'info'),
    chip(`近 7 天待发 ${number(report.metrics?.awaitingShipment)}`, 'warn'),
    chip(`结算匹配明细 ${number(report.finance?.settledLines)}`, 'muted'),
  );
  list.replaceChildren(...report.modules.map(role => {
    const item = node('li');
    item.append(node('strong', '', role.name), node('span', '', role.result));
    return item;
  }));
}

let selectedDay;
let displayedToday;

const activityStatus = new Map([
  ['verified', ['已核对', 'ok']], ['partial', ['覆盖有缺口', 'warn']], ['unavailable', ['暂无完整回执', 'muted']],
  ['stale', ['上次回执', 'warn']], ['pending', ['待核对', 'muted']],
]);
const orderLabels = new Map([
  ['AWAITING_SHIPMENT', '待发货'], ['awaiting_shipment', '待发货'],
  ['AWAITING_COLLECTION', '待揽收'], ['awaiting_collection', '待揽收'],
  ['IN_TRANSIT', '运输中'], ['DELIVERED', '已送达'], ['CANCELLED', '已取消'], ['COMPLETED', '已完成'],
]);
const videoLabels = new Map([['public', '已公开'], ['published', '已发布'], ['verified', '已核发布'],
  ['platform_success', '已核发布'], ['unknown', '待核'], ['UNKNOWN', '待核']]);
const targetForDay = 15;

let activity;
let activityDay;
let activityRequest = 0;
let activeDrilldown;

function activityMeta(section) {
  const status = section?.status ?? section?.state;
  const [label, style] = activityStatus.get(status) ?? ['回执待核', 'muted'];
  const fragment = document.createDocumentFragment();
  fragment.append(chip(label, style));
  const freshness = section?.asOf ?? section?.observedAt;
  if (freshness) fragment.append(node('span', '', `截至 ${stamp(freshness)}`));
  return fragment;
}

function makeMeter(value, max, label, className = '') {
  const meter = node('progress', className);
  meter.max = Math.max(1, max);
  if (Number.isSafeInteger(value)) meter.value = value;
  else meter.value = 0;
  meter.setAttribute('aria-label', label);
  return meter;
}

function makeDrilldownButton(type, key, label, count, unit, max, subtitle) {
  const button = node('button', `business-item ${type}-item`);
  button.type = 'button';
  button.dataset.activityType = type;
  button.dataset.activityKey = key;
  button.setAttribute('aria-label', `${label} · ${count == null ? '待核' : `${count} ${unit}`} · 查看明细`);
  const title = node('span', 'business-item-title');
  const icon = node('span', `ops-icon ${type === 'warehouse' ? 'home-icon' : 'video-icon'}`);
  icon.setAttribute('aria-hidden', 'true');
  title.append(icon, node('span', '', label));
  const result = node('span', 'business-item-count');
  result.append(node('strong', '', dashboardNumber(count)));
  if (count != null) result.append(node('small', '', unit));
  const arrow = node('span', 'business-chevron', '›');
  arrow.setAttribute('aria-hidden', 'true');
  if (subtitle) result.append(node('small', 'business-subtitle', subtitle));
  button.append(title, makeMeter(count, max, `${label} ${count == null ? '待核' : `${count} ${unit}`}`, 'business-meter'), result, arrow);
  return button;
}

function listedCount(section, rows) {
  const value = section?.total ?? section?.count;
  if (Number.isSafeInteger(value)) return value;
  if (rows.length && rows.every(row => Number.isSafeInteger(row.count))) return rows.reduce((sum, row) => sum + row.count, 0);
  return null;
}

function totalForStatus(section, rows, field) {
  if (Number.isSafeInteger(section?.[field])) return section[field];
  if (rows.length && rows.every(row => Number.isSafeInteger(row[field]))) return rows.reduce((sum, row) => sum + row[field], 0);
  return null;
}

function showBusinessTotal(id, count, suffix) {
  byId(id).replaceChildren(node('strong', '', dashboardNumber(count)), node('span', '', suffix));
}

function renderPublishingTrend(trend) {
  const chart = byId('publish-trend');
  const rows = Array.isArray(trend) ? trend : [];
  const max = Math.max(targetForDay, ...rows.map(row => row.count ?? 0));
  chart.replaceChildren(...rows.map(row => {
    const button = node('button', 'trend-item');
    button.type = 'button';
    button.dataset.activityType = 'day';
    button.dataset.activityKey = row.day;
    if (row.day === activity?.day) button.setAttribute('aria-current', 'date');
    button.setAttribute('aria-label', `${row.day} · ${row.count == null ? '发布待核' : `发布 ${row.count} 条`} · 查看账号明细`);
    const bar = makeMeter(row.count, max, dashboardNumber(row.count), 'trend-bar');
    bar.classList.toggle('missing', row.count == null);
    button.append(node('strong', 'trend-value', dashboardNumber(row.count)), bar, node('time', '', row.day?.slice(5) ?? ''));
    return button;
  }));
  if (!rows.length) chart.append(node('p', 'note', '暂无逐日发布回执。'));
}

function renderActivity(payload) {
  activity = payload;
  const { fulfillment, publishing } = payload;
  const warehouses = fulfillment?.warehouses ?? [];
  const accounts = publishing?.accounts ?? [];
  const warehouseCount = totalForStatus(fulfillment, warehouses, 'pendingShipment');
  const collectionCount = totalForStatus(fulfillment, warehouses, 'awaitingCollection');
  const posted = listedCount(publishing, accounts);
  const maxWarehouse = Math.max(1, ...warehouses.map(item => item.pendingShipment ?? item.count ?? 0));
  const maxAccount = Math.max(1, ...accounts.map(item => item.target ?? item.count ?? 0));

  byId('warehouse-meta').replaceChildren(activityMeta(fulfillment));
  byId('publish-meta').replaceChildren(activityMeta(publishing));
  showBusinessTotal('warehouse-total', warehouseCount, '单待发');
  showBusinessTotal('publish-total', posted, ` / ${publishing?.target ?? targetForDay} 条`);
  byId('warehouse-rows').replaceChildren(...warehouses.map((item, index) =>
    makeDrilldownButton('warehouse', String(index), item.name, item.pendingShipment ?? item.count, '单', maxWarehouse,
      item.awaitingCollection == null ? '' : `待揽收 ${item.awaitingCollection}`)));
  byId('publish-rows').replaceChildren(...accounts.map((item, index) =>
    makeDrilldownButton('account', String(index), item.name, item.count, '条', item.target ?? maxAccount,
      item.pendingCount > 0 ? `另 ${item.pendingCount} 条待核` : '')));
  byId('warehouse-message').textContent = fulfillment?.message ?? '';
  byId('publish-message').textContent = publishing?.message ?? '';
  byId('warehouse-message').hidden = !fulfillment?.message;
  byId('publish-message').hidden = !publishing?.message;
  const overviewActions = byId('dispatch-count');
  overviewActions.textContent = warehouseCount != null ? `${warehouseCount} 单待发` : '仓库数量待核';
  byId('kpi-dispatch').textContent = dashboardNumber(warehouseCount);
  byId('quick-dispatch').textContent = dashboardNumber(warehouseCount);
  byId('kpi-collection').textContent = dashboardNumber(collectionCount);
  byId('kpi-published').textContent = dashboardNumber(posted);
  byId('kpi-publish-label').textContent = activityDay && activityDay !== displayedToday ? '当日已发布' : '今日已发布';
  renderPublishingTrend(publishing?.trend);
}

async function readActivity(day) {
  const url = '/api/operations/activity' + (day ? '?day=' + encodeURIComponent(day) : '');
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Activity unavailable');
  return response.json();
}

async function refreshActivity() {
  const request = ++activityRequest;
  const error = byId('activity-error');
  const date = byId('activity-day');
  const day = activityDay ?? displayedToday ?? date.value;
  try {
    const payload = await readActivity(day);
    if (request !== activityRequest) return;
    renderActivity(payload);
    date.value = payload.day;
    if (displayedToday) date.max = displayedToday;
    error.hidden = true;
  } catch {
    if (request !== activityRequest) return;
    error.textContent = activity ? '暂时无法更新仓库与发布回执，当前显示上次读取结果。' : '暂时无法读取仓库与发布回执。';
    error.hidden = false;
    if (activity) date.value = activity.day;
  }
}

function appendSource(parent, value) {
  if (typeof value === 'string' && value) parent.append(node('small', 'source-ref', value));
}

function detailRecord({ id, status, subtitle, nextAction, source, url }) {
  const row = node('li', 'drill-record');
  const title = node('strong', 'drill-id', id ?? '对象待核');
  const header = node('div', 'drill-record-head');
  const video = typeof url === 'string' && URL.parse(url);
  if (video?.protocol === 'https:' && ['www.tiktok.com', 'tiktok.com', 'shop.tiktok.com', 'vt.tiktok.com'].includes(video.hostname) &&
      !video.username && !video.password) {
    const link = node('a', 'text-link', id ?? '打开原视频');
    link.href = video.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    header.append(link);
  } else {
    header.append(title);
  }
  if (status) header.append(chip(status, 'info'));
  row.append(header);
  if (subtitle) row.append(node('p', 'note', subtitle));
  if (nextAction) row.append(node('p', 'drill-next', nextAction));
  appendSource(row, source);
  return row;
}

function buildDetails(type, payload, index) {
  const warehouse = type === 'warehouse' || type === 'collection';
  const onlyCollection = type === 'collection';
  const section = warehouse ? payload.fulfillment : payload.publishing;
  const rows = warehouse ? (section?.warehouses ?? []) : (section?.accounts ?? []);
  const selected = index == null ? rows : [rows[index]].filter(Boolean);
  const title = index == null ? (onlyCollection ? '各仓待揽收订单' : warehouse ? '各仓订单明细' : '五账号发布明细') : selected[0]?.name ?? '活动明细';
  byId('drill-title').textContent = title;
  const meta = byId('drill-meta');
  meta.replaceChildren(node('span', '', payload.day), activityMeta(section));
  const body = byId('drill-body');
  body.replaceChildren();
  if (section?.message) body.append(node('p', 'note', section.message));
  appendSource(body, section?.source);
  for (const group of selected) {
    const block = node('section', 'drill-group');
    const sliceCount = onlyCollection ? group.awaitingCollection : group.count;
    const count = sliceCount == null ? '待核' : `${sliceCount} ${warehouse ? '单' : '条'}`;
    const orders = group.orders ?? [];
    const records = onlyCollection ? orders.filter(row => orderLabels.get(row.statusCode ?? row.status) === '待揽收' || row.status === '待揽收') :
      warehouse ? orders : group.videos;
    block.append(node('h3', '', `${group.name} · ${count}`));
    if (records?.length) {
      const list = node('ul', 'drill-records');
      list.append(...records.map(row => {
        const sku = row.sku ?? row.sellerSku ?? row.skuId;
        if (warehouse) return detailRecord({ id: row.orderId, status: orderLabels.get(row.statusCode ?? row.status) ?? row.status,
          subtitle: [sku ? `SKU ${sku}` : '', Number.isSafeInteger(row.quantity) ? `${row.quantity} 件` : ''].filter(Boolean).join(' · '),
          nextAction: row.nextAction, source: row.source });
        return detailRecord({ id: row.videoId, status: videoLabels.get(row.status) ?? row.status,
          subtitle: [row.publishedAt ? `发布 ${stamp(row.publishedAt)}` : '', sku ? `SKU ${sku}` : ''].filter(Boolean).join(' · '),
          nextAction: row.nextAction, source: row.source, url: row.url ?? row.videoUrl });
      }));
      block.append(list);
    } else {
      block.append(node('p', 'note', sliceCount === 0 ? '本次回执为 0。' : '目前没有可回读的逐条记录。'));
    }
    if (!warehouse && group.pending?.length) {
      const list = node('ul', 'drill-records');
      list.append(...group.pending.map(row => detailRecord({ id: row.videoId ?? row.title ?? '待核发布记录',
        status: row.status ?? '平台回执待核', subtitle: row.sku ? `SKU ${row.sku}` : '', nextAction: row.nextAction, source: row.source })));
      block.append(node('h4', 'drill-pending', '待核发布'), list);
    }
    body.append(block);
  }
  if (!selected.length) body.append(node('p', 'note', '当前没有可回读的明细。'));
}

async function showDrilldown(type, key) {
  if (!activity) return;
  const dialog = byId('drilldown');
  const request = Symbol();
  activeDrilldown = request;
  if (!dialog.open) dialog.showModal();
  if (type !== 'day') {
    buildDetails(type, activity, key ? Number(key) : null);
    return;
  }
  byId('drill-title').textContent = '五账号发布明细';
  byId('drill-meta').textContent = key;
  byId('drill-body').replaceChildren(node('p', 'note', '正在读取当日发布回执…'));
  try {
    const payload = key === activity.day ? activity : await readActivity(key);
    if (activeDrilldown === request && dialog.open) buildDetails('account', payload, null);
  } catch {
    if (activeDrilldown === request && dialog.open) byId('drill-body').replaceChildren(node('p', 'note', '当日发布回执暂时无法读取。'));
  }
}

function render(data) {
  const { today, current, sync, checkedAt, days, report } = data;
  const syncState = byId('sync-state');
  const syncLabel = sync.running ? ['正在取数', 'info'] : sync.error ? ['取数待恢复', 'warn'] :
    sync.lastSuccessfulRun ? ['后台取数在线', 'ok'] : ['本地数据已打开', 'muted'];
  syncState.textContent = syncLabel[0];
  syncState.className = 'chip ' + syncLabel[1];
  byId('sync-time').textContent = `店铺数据 ${stamp(current.metrics?.collectedAt)}`;
  byId('checked-at').textContent = `面板检查 ${stamp(checkedAt)}`;
  byId('market').textContent = current.metrics?.shop ? `TikTok Shop · MY · ${current.metrics.shop}` : 'TikTok Shop · MY';
  byId('footer-status').textContent = sync.scheduled ? `后台约每 ${sync.intervalMinutes} 分钟读一次店铺${sync.nextAt ? ` · 下次 ${stamp(sync.nextAt)}` : ''}` : '本次后台定时取数未启用';
  renderMetrics(current.metrics, today);
  renderAttention(current);
  renderModules(current.modules);
  const select = byId('day');
  const selected = selectedDay ?? today;
  displayedToday = today;
  select.replaceChildren(...days.map(day => {
    const option = node('option', '', day === today ? `${day}（今天）` : day);
    option.value = day;
    return option;
  }));
  select.value = days.includes(selected) ? selected : today;
  renderReport(report);
}

let refreshRequest = 0;
async function refreshBoard() {
  const request = ++refreshRequest;
  const day = selectedDay;
  const error = byId('error');
  try {
    const response = await fetch(day ? '/api/operations?day=' + encodeURIComponent(day) : '/api/operations', { cache: 'no-store' });
    if (!response.ok) throw new Error('status');
    const data = await response.json();
    if (request !== refreshRequest) return;
    render(data);
    error.hidden = !data.sync.error;
    error.textContent = data.sync.error ?? '';
  } catch {
    if (request !== refreshRequest) return;
    error.hidden = false;
    error.textContent = '暂时无法读取本地面板，请检查运营工作台是否在运行。';
  }
}

let queueRequest = 0;
let loadedRole;
let lastQueueSnapshot;
async function refreshQueue() {
  const request = ++queueRequest;
  const role = selectedRole();
  const status = byId('task-status');
  if (loadedRole !== role) {
    byId('task-groups').hidden = true;
    status.textContent = '正在读取任务队列…';
    status.hidden = false;
  }
  try {
    const endpoint = '/api/operations/tasks' + (role ? '?role=' + encodeURIComponent(role) : '');
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error('status');
    const queue = await response.json();
    if (request !== queueRequest) return;
    const snapshot = JSON.stringify(queue);
    if (loadedRole !== role || lastQueueSnapshot !== snapshot) renderQueue(queue, role);
    status.hidden = true;
    byId('task-groups').hidden = false;
    lastQueueSnapshot = snapshot;
    loadedRole = role;
  } catch {
    if (request !== queueRequest) return;
    status.textContent = loadedRole === role ? '本轮暂时读不到任务队列，下方显示上次成功读取。' : '任务队列暂时无法读取。';
    status.hidden = false;
    if (loadedRole === undefined) byId('queue-runs').replaceChildren(node('li', 'queue-run note', '暂时无法读取运行回执。'));
  }
}

async function refresh() {
  const button = byId('refresh');
  if (button.disabled) return;
  button.disabled = true;
  await Promise.all([refreshBoard(), refreshQueue(), refreshActivity(), refreshQueueMetrics()]);
  button.disabled = false;
}

let viewedRole = selectedRole();
function updateLocation() {
  markLocation();
  const role = selectedRole();
  if (role !== viewedRole) {
    viewedRole = role;
    void refreshQueue();
  }
}

document.addEventListener('click', event => {
  const link = event.target.closest('#role-links a, a[data-role-link]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (link.href !== location.href) history.pushState(null, '', link.href);
  updateLocation();
  if (link.hasAttribute('data-role-link')) {
    const tasks = byId('tasks-title');
    tasks.tabIndex = -1;
    tasks.focus({ preventScroll: true });
    byId('tasks').scrollIntoView();
  }
});
window.addEventListener('popstate', updateLocation);
window.addEventListener('hashchange', updateLocation);
byId('refresh').addEventListener('click', refresh);
byId('day').addEventListener('change', event => {
  selectedDay = event.target.value === displayedToday ? undefined : event.target.value;
  void refreshBoard();
});
byId('activity-day').addEventListener('change', event => {
  if (!event.target.value || !event.target.validity.valid) return;
  activityDay = event.target.value;
  void refreshActivity();
});
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-activity-type]');
  if (button) void showDrilldown(button.dataset.activityType, button.dataset.activityKey);
});
byId('drilldown').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
markLocation();
void refresh();
setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
