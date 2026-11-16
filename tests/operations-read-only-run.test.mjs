import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runReadOnlyReview } from '../scripts/operations/run-read-only-review.mjs';
import { createOperationsBoard } from '../apps/customer-service/operations-board.mjs';
import { collectBoardEvidence, summarizeLocalVideoReview } from '../apps/customer-service/operations-board-evidence.mjs';
import { createRunEvidence } from '../apps/customer-service/operations-board-runs.mjs';

const basis = '20261112T130832233Z-cae88581-fbbb-4e18-bac3-6e4336aa2422.json';
const financePath = join('snapshots', 'finance', '20261112T131321778Z-a2c7beb4-24a8-42bc-8e2e-d02581f855ae.json');

test('reports the schedule trigger only when it belongs to the displayed turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-board-run-trigger-'));
  t.after(() => rm(root, { recursive: true }));
  const path = join(root, 'rollout.jsonl');
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('00000000-0000-4000-8000-000000000003', path);
  } finally {
    db.close();
  }
  const event = (timestamp, type, turnId, trigger) => JSON.stringify({ timestamp, type: 'event_msg',
    payload: { type, turn_id: turnId, turn_attribution: trigger && { turn_trigger: trigger } } });
  const started = '2026-11-13T08:32:49.037Z';
  const ended = '2026-11-13T08:34:41.560Z';
  const scheduled = event(started, 'task_started', 'scheduled-turn', 'automation_heartbeat_scheduled');
  const read = createRunEvidence(join(root, 'automations'));
  const log = (...entries) => writeFile(path, entries.join('\n') + '\n');
  await log(scheduled, event(ended, 'task_complete', 'scheduled-turn'));
  assert.deepEqual((await read()).listing, { state: 'ended', at: ended, trigger: 'automation_heartbeat_scheduled' });
  await log(scheduled, event(ended, 'task_complete', 'different-turn'));
  assert.deepEqual((await read()).listing, { state: 'ended', at: ended });
});

test('shows the original A28 draft and its permission gap even without an active listing pilot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-board-draft-'));
  t.after(() => rm(root, { recursive: true }));
  const day = '2026-11-13';
  const observedAt = '2026-11-13T02:19:04Z';
  const directory = join(root, 'outputs', 'operations-daily-work', day);
  await mkdir(directory, { recursive: true });
  const candidate = {
    sku: 'MY-CAR-PROJECTION-733047859765-CUSTOM-KIT',
    originalGap: '缺覆盖该国旗投影商品商业销售的马来西亚主管部门书面许可。',
    result: { lookup: 'known_product_id', products: [{ productId: '9000000000000000054',
      skuId: '9000000000000000055', state: 'DRAFT', imageCount: 2, draftVersionRequested: true, requestId: 'fixture',
      price: { sale_price: '0' }, listedQuantity: 0, descriptionPresent: false,
      packageDimensions: { length: '0', width: '0', height: '0' } }] },
  };
  const handoff = { observedAt, candidates: [candidate] };
  const receipt = { day, defaults: { shopId: '9000000000000000099' }, selection: { handoff: { result: handoff } } };
  const file = join(directory, 'review-fixture.json');
  async function listing() {
    await writeFile(file, JSON.stringify(receipt));
    const rows = await collectBoardEvidence({ root, scheduleDirectory: join(root, 'automations'), day, sync: {} });
    return rows.find(row => row.id === 'listing');
  }
  const draft = await listing();
  assert.match(draft.result, /A28 .*原草稿.*2 张图/);
  assert.match(draft.result, /售价、库存和外箱三边为 0/);
  assert.match(draft.result, /主管部门书面许可/);
  assert.equal(draft.at, observedAt);
  candidate.result.products[0].state = 'ACTIVATE';
  assert.doesNotMatch((await listing()).result, /原草稿|主管部门书面许可/);
});

test('reports reviewed source clips without counting them as delivery or publication', () => {
  const row = (state, hash) => ({ state, assetSha256: hash.repeat(64), publicationReady: false, accountAssigned: null });
  const receipt = { schema: 'operations-local-video-variant-review/v1', observedAt: '2026-11-13T02:37:17Z',
    shop: { id: '9000000000000000099', region: 'MY', name: 'example-shop-my' },
    product: { id: '9000000000000000016', skuId: '9000000000000000035', status: 'ACTIVATE', audit: 'APPROVED', requestId: 'fixture' },
    localFiles: 2, uploads: 0, submissions: 0, rows: [row('hold_unverified_radar_rotation', 'a'),
      row('candidate_pending_audio_and_product_readback', 'b')] };
  assert.deepEqual(summarizeLocalVideoReview(receipt, '2026-11-13'), { at: receipt.observedAt, checked: 2, held: 1, pending: 1 });
  assert.equal(summarizeLocalVideoReview({ ...receipt, submissions: 1 }, '2026-11-13'), null);
  assert.equal(summarizeLocalVideoReview(receipt, '2026-11-12'), null);
});

test('shows a paid historical checkout control separately from an active trial with no sales', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-board-checkout-'));
  t.after(() => rm(root, { recursive: true }));
  const day = '2026-11-13';
  const shopId = '9000000000000000099';
  const skuId = '9000000000000000027';
  const orderId = '900000000000000013';
  const orderLineId = '900000000000000014';
  const statementId = '9000000000000000133';
  const control = { schema: 'operations-pilot-checkout-settlement-control/v1', observedAt: '2026-11-13T04:03:10Z',
    shop: { id: shopId, region: 'MY', name: 'example-shop-my' }, productId: '9000000000000000016', skuId, writes: 0,
    orderEconomics: [{ orderId, orderLineIds: [orderLineId], checkoutState: 'exact_buyer_price', settlementState: 'statement_reference',
      checkout: { currency: 'MYR', orderPayment: '13.78', lines: [{ id: orderLineId, currency: 'MYR', buyerProduct: '13.78' }] },
      settlement: { currency: 'MYR', skuId, statementId, settlementAmount: '10.51' } }],
    statementPayments: { state: 'index_read', orders: [{ orderId, statementId, paymentStatus: 'PAID', paymentId: '9000000000000000080' }] },
    trace: [['/order/202507/orders', 'GET'], [`/order/202407/orders/${orderId}/price_detail`, 'GET'],
      [`/finance/202501/orders/${orderId}/statement_transactions`, 'GET'], ['/finance/202309/statements', 'GET']]
      .map(([path, method]) => ({ path, method, status: 200, code: 0, requestId: 'fixture' })) };
  const directory = join(root, 'outputs', 'operations-order-unit-economics', day, skuId);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'pilot-checkout-settlement-control-2026-11-13T04-03-10-000Z.json');
  const trackedPilot = { state: 'active_configuration_verified', sellerSku: 'pool', price: { amount: '29.90', currency: 'MYR' },
    orderLines: 0, observedAt: '2026-11-13T04:02:23Z' };
  async function result() {
    await writeFile(file, JSON.stringify(control));
    const rows = await collectBoardEvidence({ root, scheduleDirectory: join(root, 'automations'), day, trackedPilot, sync: {} });
    return rows.find(row => row.id === 'promotion').result;
  }
  assert.match(await result(), /匹配 0 条订单明细.*历史订单.*RM13.78.*RM10.51/);
  trackedPilot.skuId = skuId;
  assert.doesNotMatch(await result(), /历史订单/);
  delete trackedPilot.skuId;
  control.statementPayments.orders[0].statementId = '9000000000000000134';
  assert.doesNotMatch(await result(), /历史订单/);
});

test('requires matching SKU and statement for settlement of a sampled discounted order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-board-promotion-payment-'));
  t.after(() => rm(root, { recursive: true }));
  const day = '2026-11-13';
  const directory = join(root, 'outputs', 'operations-promotion-outcome', day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'active-promotion-checkout-controls-2026-11-13T10-49-46-251Z.json');
  const activityId = '9000000000000000108';
  const productId = '9000000000000000016';
  const skuId = '9000000000000000027';
  const orderId = '900000000000000010';
  const orderLineId = '900000000000000014';
  const statementId = '9000000000000000133';
  const settlement = { currency: 'MYR', skuId, statementId, quantity: 1, settlementAmount: '10.39' };
  const payment = { orderId, statementId, paymentStatus: 'PAID', paymentId: '9000000000000000080' };
  const receipt = { schema: 'operations-active-promotion-checkout-controls/v1', observedAt: '2026-11-13T10:49:46.251Z',
    shop: { id: '9000000000000000099', region: 'MY', name: 'example-shop-my' }, writes: 0,
    results: [{ productId, skuId, activity: { id: activityId, applies: true }, details: [{ orderId, orderLineIds: [orderLineId],
      checkoutState: 'exact_buyer_price', checkout: { currency: 'MYR', lines: [{ id: orderLineId, currency: 'MYR',
        buyerProduct: '10.50', sellerDiscount: '49.96' }] }, settlementState: 'statement_reference', settlement }] }],
    statementPayments: { state: 'index_read', orders: [payment] },
    trace: [`/promotion/202309/activities/${activityId}`, `/product/202309/products/${productId}`, '/order/202507/orders',
      `/order/202407/orders/${orderId}/price_detail`, `/finance/202501/orders/${orderId}/statement_transactions`, '/finance/202309/statements']
      .map(path => ({ path, method: 'GET', status: 200, code: 0, requestId: 'fixture' })) };
  async function result() {
    await writeFile(file, JSON.stringify(receipt));
    const rows = await collectBoardEvidence({ root, scheduleDirectory: join(root, 'automations'), day, sync: {} });
    return rows.find(row => row.id === 'promotion').result;
  }
  assert.match(await result(), /活动归属待平台明细确认.*1 笔订单 SKU 已对齐净结算，1 笔的账单付款已回读.*RM10.39/);
  payment.statementId = '9000000000000000134';
  assert.match(await result(), /1 笔订单 SKU 已对齐净结算，0 笔的账单付款已回读/);
  settlement.skuId = '9000000000000000028';
  const mismatched = await result();
  assert.match(mismatched, /商家让利 RM49.96/);
  assert.doesNotMatch(mismatched, /对齐净结算|RM10.39/);
});

test('a failed morning promotion read keeps its old receipt and retries at the next board sync', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-board-test-'));
  t.after(() => rm(root, { recursive: true }));
  const boardDirectory = join(root, 'apps/customer-service/data/operations-board');
  const promotionFile = join(boardDirectory, 'promotion.json');
  await mkdir(boardDirectory, { recursive: true });
  const previousAt = '2026-11-12T15:30:00.000Z';
  const prior = { state: 'verified', checkedAt: previousAt, rows: [], coveredProducts: 3, partialProducts: 0, uncoveredProducts: 2 };
  await writeFile(promotionFile, JSON.stringify(prior));
  let time = Date.parse('2026-11-12T23:00:00Z');
  let audits = 0;
  const board = createOperationsBoard({ root, scheduleDirectory: join(root, 'automations'), scheduled: true,
    now: () => time,
    syncShop: async () => ({ shop: { id: '9000000000000000099', name: 'example-shop-my', region: 'MY' },
      collectedAt: new Date(time).toISOString(), products: { rows: [] }, orders: { rows: [] } }),
    auditPromotions: async () => {
      if (++audits === 1) throw new Error('Temporary platform timeout');
      const fresh = { ...prior, checkedAt: new Date(time).toISOString(), coveredProducts: 4 };
      await writeFile(promotionFile, JSON.stringify(fresh));
      return fresh;
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  async function statusAfterSync() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await board.status();
      if (!status.sync.running) return status;
    }
    assert.fail('Board sync did not finish');
  }
  board.start();
  assert.equal(board.refreshSources(), false);
  const failed = await statusAfterSync();
  assert.equal(failed.current.promotion.checkedAt, previousAt);
  assert.ok(failed.sync.promotionError);
  time += 30 * 60_000;
  t.mock.timers.tick(30 * 60_000);
  const recovered = await statusAfterSync();
  assert.equal(recovered.sync.promotionError, null);
  assert.equal(recovered.current.promotion.coveredProducts, 4);
  const restarted = createOperationsBoard({ root, now: () => time });
  await restarted.status(undefined, { includeModules: false });
  assert.equal(restarted.catalogueSnapshot().collectedAt, new Date(time).toISOString());
  assert.equal(restarted.catalogueSnapshot().shop.id, '9000000000000000099');
  assert.deepEqual(restarted.catalogueSnapshot().products.rows, []);
  time += 30 * 60_000;
  t.mock.timers.tick(30 * 60_000);
  await statusAfterSync();
  assert.equal(audits, 2);
});

test('uses the same new order snapshot for finance and writes one verified receipt', async t => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'operations-read-test-'));
  t.after(() => rm(receiptDirectory, { recursive: true }));
  const calls = [];
  const run = await runReadOnlyReview({
    receiptDirectory,
    sync: async (shopId, options) => {
      calls.push([shopId, options]);
      return { output: options ? financePath : join('snapshots', basis) };
    },
    review: file => {
      assert.equal(file, financePath);
      return { catalogFile: basis, statementsStatus: 'available', refundsStatus: 'available',
        summary: { orders: 7 }, costReviewQueue: [{ skuId: 's1' }] };
    },
  });
  assert.deepEqual(calls, [['9000000000000000099', undefined], ['9000000000000000099', { financeBasis: basis }]]);
  assert.equal(run.state, 'verified');
  const saved = JSON.parse(await readFile(run.receiptPath, 'utf8'));
  assert.equal(saved.review.summary.orders, 7);
  assert.equal(saved.review.costReviewQueue.length, 1);
  assert.equal((await readdir(receiptDirectory)).length, 1);
});

test('leaves prior successes intact and records the completed step on finance failure', async t => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'operations-read-test-'));
  t.after(() => rm(receiptDirectory, { recursive: true }));
  const good = await runReadOnlyReview({ receiptDirectory,
    sync: async (_shopId, options) => ({ output: options ? financePath : join('snapshots', basis) }),
    review: () => ({ catalogFile: basis, statementsStatus: 'available', refundsStatus: 'available',
      summary: { orders: 7 }, costReviewQueue: [] }) });
  const prior = await readFile(good.receiptPath, 'utf8');
  const bad = await runReadOnlyReview({
    receiptDirectory,
    sync: async (_shopId, options) => {
      if (options) throw new Error('Finance unavailable');
      return { output: join('snapshots', basis) };
    },
    review: () => assert.fail('Review should not run when finance is unavailable'),
  });
  assert.equal(bad.state, 'failed');
  assert.equal(bad.failedStep, 'finance');
  assert.equal(bad.catalogFile, basis);
  assert.equal(await readFile(good.receiptPath, 'utf8'), prior);
  assert.equal((await readdir(receiptDirectory)).length, 2);
});
