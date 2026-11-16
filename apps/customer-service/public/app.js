'use strict';

const byId = id => document.getElementById(id);
const buyerView = location.pathname.replace(/\/$/, '') === '/buyer';
const initialParams = new URLSearchParams(location.search);
const detailButtons = [...document.querySelectorAll('[data-detail-tab]')];
const filterButtons = [...document.querySelectorAll('[data-filter]')];
const marketTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const marketDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Kuala_Lumpur', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

let state = { conversations: [] };
let activeId = initialParams.get('conversation');
let detailTab = detailButtons.some(button => button.dataset.detailTab === initialParams.get('detail'))
  ? initialParams.get('detail') : 'order';
let filter = 'all';
let loading = false;
let busy = false;
let requestGeneration = 0;
let retryOperation;
let threadRenderKey;
let inboxRenderKey;
let detailRenderKey;
let buyerOptionsKey;
let renderedConversation;
let formTextOwner;
const drafts = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeNode(iso, format = marketTime) {
  const node = element('time', '', '—');
  const value = new Date(iso);
  if (iso && Number.isFinite(value.getTime())) {
    node.dateTime = iso;
    node.textContent = format.format(value);
    node.title = `${marketDate.format(value)}（马来西亚时间）`;
  }
  return node;
}

function valueText(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

function latest(conversation) {
  return conversation.messages.at(-1);
}

function current() {
  return state.conversations.find(conversation => conversation.id === activeId);
}

function conversationsForFilter() {
  if (buyerView || filter === 'all') return state.conversations;
  return state.conversations.filter(conversation => conversation.status === filter);
}

function setNotice(id, message = '', isError = false) {
  const node = byId(id);
  if (node.textContent !== message) node.textContent = message;
  node.classList.toggle('error', isError);
}

function showConnection(message = '') {
  const node = byId('connection');
  if (node.textContent !== message) node.textContent = message;
  node.hidden = !message;
}

function activeLink() {
  const link = byId('switch-view');
  const route = buyerView ? '/' : '/buyer';
  link.href = activeId ? `${route}?conversation=${encodeURIComponent(activeId)}` : route;
}

function focusListRow(id) {
  [...byId('conversation-list').children].find(node => node.dataset.conversationId === id)
    ?.focus({ preventScroll: true });
}

function statusFor(conversation) {
  if (conversation.status === 'resolved') return ['已结案', 'resolved'];
  if (conversation.status === 'human') return ['待人工', 'human'];
  if (latest(conversation)?.from === 'buyer') return ['待回复', 'waiting'];
  return ['会话中', ''];
}

function deadlineFor(conversation) {
  if (conversation.status === 'resolved' || latest(conversation)?.from !== 'buyer') return null;
  const time = Date.parse(conversation.dueAt);
  if (!Number.isFinite(time)) return null;
  const minutes = Math.ceil((time - Date.now()) / 60000);
  if (minutes <= 0) return ['内部提醒已到时', true];
  const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
  return [`距内部提醒 ${remaining}`, minutes <= 20];
}

function renderInbox() {
  const list = byId('conversation-list');
  const options = conversationsForFilter();
  const human = state.conversations.filter(conversation => conversation.status === 'human').length;
  byId('human-count').textContent = human || '';
  byId('inbox-count').textContent = `${options.length} 个会话`;
  for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));

  const rows = options.map(conversation => [conversation, deadlineFor(conversation)]);
  const key = JSON.stringify([activeId, rows]);
  if (inboxRenderKey === key) return;
  inboxRenderKey = key;

  const previousFocus = list.contains(document.activeElement) ? document.activeElement.dataset.conversationId : null;
  const scroll = list.scrollTop;
  const nodes = rows.map(([conversation, deadline]) => {
    const button = element('button', 'conversation-item');
    button.type = 'button';
    button.dataset.conversationId = conversation.id;
    button.setAttribute('aria-current', String(conversation.id === activeId));

    const avatar = element('span', 'avatar', conversation.initials);
    avatar.setAttribute('aria-hidden', 'true');
    const content = element('span');
    const headline = element('span', 'conversation-top');
    const last = latest(conversation);
    headline.append(element('strong', '', conversation.buyer), timeNode(last?.at));
    const preview = element('span', 'conversation-preview', last?.text || conversation.topic);
    const [status, kind] = statusFor(conversation);
    const footer = element('span', 'conversation-bottom');
    footer.append(element('span', `status-pill ${kind}`, status));
    if (deadline) footer.append(element('span', `deadline${deadline[1] ? ' urgent' : ''}`, deadline[0]));
    content.append(headline, preview, footer);
    button.append(avatar, content);
    return button;
  });
  list.replaceChildren(...(nodes.length ? nodes : [element('p', 'placeholder', '暂无符合条件的会话。')]));
  list.scrollTop = scroll;
  if (previousFocus) focusListRow(previousFocus);
}

function renderMessage(message, conversation) {
  const outgoing = buyerView ? message.from === 'buyer' : message.from !== 'buyer';
  const isAuto = message.from === 'auto';
  const item = element('article', `message${outgoing ? ' outgoing' : ''}${isAuto ? ' auto' : ''}`);
  item.dataset.messageFrom = message.from;
  const icon = message.from === 'buyer' ? conversation.initials : isAuto ? '自' : '人';
  const avatar = element('span', 'avatar', icon);
  avatar.setAttribute('aria-hidden', 'true');
  const body = element('div', 'message-body');
  const meta = element('p', 'message-meta');
  const label = message.from === 'buyer' ? (buyerView ? '我' : conversation.buyer) : isAuto ? '自动回复' : '人工客服';
  meta.append(element('strong', '', label), timeNode(message.at));
  body.append(meta, element('p', 'bubble', message.text));
  item.append(avatar, body);
  return item;
}

function renderThread(conversation) {
  const list = byId(buyerView ? 'buyer-messages' : 'thread-messages');
  const key = JSON.stringify([conversation?.id, conversation?.messages]);
  if (threadRenderKey !== key) {
    const scroll = list.scrollTop;
    const pinBottom = renderedConversation !== conversation?.id || list.scrollHeight - scroll - list.clientHeight < 60;
    const messages = conversation?.messages.map(message => renderMessage(message, conversation)) ?? [];
    list.replaceChildren(...(messages.length ? messages : [element('p', 'placeholder', conversation ? '暂无消息。' : '请选择一个会话。')]));
    list.scrollTop = pinBottom ? list.scrollHeight : scroll;
    renderedConversation = conversation?.id;
    threadRenderKey = key;
  }

  if (buyerView) return;
  byId('thread-header').hidden = !conversation;
  if (!conversation) {
    byId('thread-notice').hidden = true;
    return;
  }

  byId('thread-avatar').textContent = conversation.initials;
  byId('thread-name').textContent = conversation.buyer;
  byId('thread-topic').textContent = conversation.topic;
  const notice = byId('thread-notice');
  const handled = conversation.status === 'human';
  const resolved = conversation.status === 'resolved';
  notice.hidden = !handled && !resolved;
  notice.classList.toggle('is-resolved', resolved);
  if (handled) notice.textContent = `人工处理 · ${conversation.assignee || '待分配'} · 自动回复已暂停`;
  if (resolved) notice.textContent = '会话已结案。买家发来新消息后会重新进入收件箱。';
}

function detailCard(title, status, entries) {
  const card = element('section', 'detail-card');
  card.append(element('h3', '', title));
  if (status) card.append(element('span', 'status-pill', status));
  if (entries.length) {
    const details = element('dl');
    for (const [name, value] of entries) {
      const row = element('div');
      const data = element('dd');
      data.append(value instanceof Node ? value : valueText(value));
      row.append(element('dt', '', name), data);
      details.append(row);
    }
    card.append(details);
  }
  return card;
}

function renderDetails(conversation) {
  const panel = byId('detail-content');
  for (const button of detailButtons) {
    const selected = button.dataset.detailTab === detailTab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected) panel.setAttribute('aria-labelledby', button.id);
  }

  const order = conversation?.order;
  const key = JSON.stringify([conversation?.id, order, detailTab]);
  if (detailRenderKey === key) return;
  detailRenderKey = key;
  panel.replaceChildren();
  if (!order) {
    panel.append(element('p', 'placeholder', conversation ? '此会话暂无关联订单。' : '请选择一个会话。'));
    return;
  }

  if (detailTab === 'order') {
    panel.append(detailCard(order.product, order.status, [
      ['订单号', order.id], ['数量', order.quantity], ['订单金额', order.total],
      ['下单时间', timeNode(order.placedAt, marketDate)]
    ]));
    return;
  }

  if (detailTab === 'shipment') {
    const shipment = order.shipment;
    if (!shipment) {
      panel.append(element('p', 'placeholder', '暂未获取到此订单的物流记录。'));
      return;
    }
    panel.append(detailCard('物流信息', shipment.status, [
      ['订单号', order.id], ['承运商', shipment.carrier], ['物流单号', shipment.tracking]
    ]));
    if (shipment.events?.length) {
      const card = detailCard('配送进度', '', []);
      const timeline = element('ol', 'timeline');
      for (const event of shipment.events) {
        const item = element('li', '', event.label);
        item.append(timeNode(event.at, marketDate));
        timeline.append(item);
      }
      card.append(timeline);
      panel.append(card);
    }
    return;
  }

  const ticket = order.afterSales;
  if (!ticket) {
    panel.append(element('p', 'placeholder', '此订单暂无退换货或退款记录。'));
    return;
  }
  const card = detailCard(ticket.type, ticket.status, [
    ['售后单号', ticket.id], ['关联订单', order.id], ['更新时间', timeNode(ticket.updatedAt, marketDate)]
  ]);
  if (ticket.notes) card.append(element('p', 'detail-note', ticket.notes));
  panel.append(card);
}

function renderBuyerOptions() {
  const select = byId('buyer-conversation');
  const key = JSON.stringify(state.conversations.map(({ id, buyer, topic }) => [id, buyer, topic]));
  if (buyerOptionsKey !== key) {
    buyerOptionsKey = key;
    const options = state.conversations.map(conversation => {
      const option = element('option', '', `${conversation.buyer} · ${conversation.topic}`);
      option.value = conversation.id;
      return option;
    });
    select.replaceChildren(...options);
  }
  if (select.value !== activeId) select.value = activeId ?? '';
  select.disabled = busy || !state.conversations.length;
}

function renderComposer(conversation) {
  const textarea = byId(buyerView ? 'buyer-message' : 'agent-reply');
  const button = byId(buyerView ? 'send-buyer' : 'send-reply');
  if (formTextOwner !== conversation?.id) {
    if (formTextOwner) drafts.set(formTextOwner, textarea.value);
    formTextOwner = conversation?.id;
    textarea.value = drafts.get(formTextOwner) || '';
    setNotice(buyerView ? 'buyer-status' : 'agent-status');
  }

  if (buyerView) {
    textarea.disabled = !conversation;
    textarea.readOnly = busy;
    button.disabled = !conversation || busy;
    return;
  }

  const resolved = conversation?.status === 'resolved';
  byId('agent-form').hidden = !conversation || resolved;
  byId('handoff').disabled = busy || !conversation || conversation.status !== 'open';
  byId('resolve').disabled = busy || !conversation || resolved;
  textarea.disabled = !conversation || resolved;
  textarea.readOnly = busy;
  button.disabled = busy || !conversation || resolved;
}

function render() {
  const options = conversationsForFilter();
  if (!options.some(conversation => conversation.id === activeId)) activeId = options[0]?.id;
  const conversation = current();
  if (buyerView) renderBuyerOptions();
  else {
    renderInbox();
    renderDetails(conversation);
  }
  renderThread(conversation);
  renderComposer(conversation);
  activeLink();
}

function setState(value) {
  if (!Array.isArray(value.conversations)) throw new Error('工作台返回的数据格式异常。');
  state = value;
  render();
}

async function refresh() {
  if (loading || busy) return;
  loading = true;
  const generation = requestGeneration;
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('连接异常');
    const value = await response.json();
    if (generation === requestGeneration) {
      setState(value);
      showConnection();
    }
  } catch {
    if (generation === requestGeneration) showConnection('连接中断，正在重试…');
  } finally {
    loading = false;
  }
}

async function act(action, input) {
  const conversation = current();
  if (busy || !conversation) return;
  const notice = buyerView ? 'buyer-status' : 'agent-status';
  const body = input ? { text: input.value.trim() } : {};
  if (input && !body.text) {
    setNotice(notice, '请输入消息。', true);
    input.focus();
    return;
  }

  const destination = `/api/conversations/${encodeURIComponent(conversation.id)}/${action}`;
  const serialized = JSON.stringify(body);
  if (!retryOperation || retryOperation.destination !== destination || retryOperation.serialized !== serialized) {
    retryOperation = { destination, serialized, key: crypto.randomUUID() };
  }
  busy = true;
  requestGeneration += 1;
  setNotice(notice, '正在处理…');
  render();
  try {
    const response = await fetch(destination, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': retryOperation.key },
      body: serialized
    });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : value.message || '操作未完成，请重试。');
    retryOperation = undefined;
    if (input) {
      input.value = '';
      drafts.delete(conversation.id);
    }
    setState(value);
    showConnection();
    setNotice(notice, input ? '已发送' : '已更新');
  } catch (error) {
    setNotice(notice, error.message === 'Failed to fetch' ? '连接异常，消息保留在输入框中。' : error.message, true);
  } finally {
    busy = false;
    render();
    if (input && formTextOwner === conversation.id) input.focus();
  }
}

if (buyerView) {
  document.title = '买家测试端 · 示例马来店运营助手';
  byId('page-title').textContent = '买家测试端';
  byId('page-subtitle').textContent = '发送测试咨询并查看客服回复';
  byId('switch-view').textContent = '返回客服工作台';
  byId('switch-view').removeAttribute('target');
  byId('desk').hidden = true;
  byId('buyer-desk').hidden = false;
  byId('buyer-conversation').addEventListener('change', event => {
    if (!busy) {
      activeId = event.target.value;
      render();
    }
  });
  byId('buyer-form').addEventListener('submit', event => {
    event.preventDefault();
    void act('buyer', byId('buyer-message'));
  });
} else {
  byId('shop-api-entry').hidden = false;
  byId('conversation-list').addEventListener('click', event => {
    const button = event.target.closest('[data-conversation-id]');
    if (!button || busy || button.dataset.conversationId === activeId) return;
    activeId = button.dataset.conversationId;
    detailTab = 'order';
    render();
  });
  for (const button of filterButtons) {
    button.addEventListener('click', () => {
      if (busy) return;
      filter = button.dataset.filter;
      render();
    });
  }
  for (const button of detailButtons) {
    button.addEventListener('click', () => {
      detailTab = button.dataset.detailTab;
      renderDetails(current());
    });
    button.addEventListener('keydown', event => {
      const index = detailButtons.indexOf(button);
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: detailButtons.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = detailButtons[(next + detailButtons.length) % detailButtons.length];
      target.click();
      target.focus();
    });
  }
  byId('handoff').addEventListener('click', () => void act('handoff'));
  byId('resolve').addEventListener('click', () => void act('resolve'));
  byId('agent-form').addEventListener('submit', event => {
    event.preventDefault();
    void act('reply', byId('agent-reply'));
  });
}

void refresh();
setInterval(() => void refresh(), 1500);
