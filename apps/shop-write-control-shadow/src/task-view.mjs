import { deepFreeze } from './intents.mjs';
import { requireValue } from './errors.mjs';

export function projectTask(record) {
  requireValue(record?.fixture_only === true && record.intent?.fixture_only === true);
  const verified = record.execution_state === 'FIXTURE_VERIFIED';
  const unknown = record.execution_state === 'UNKNOWN';
  const approved = record.approval_state === 'FIXTURE_APPROVED';
  const object = record.action === 'listing.create'
    ? { type: 'new_listing_client_sku', clientSku: record.intent.listing.client_sku, quantity: record.intent.listing.quantity, providerObjectId: record.object_id ?? null }
    : { type: 'promotion_skus', items: record.intent.items, providerObjectId: record.object_id ?? null };
  return deepFreeze({
    fixtureOnly: true, label: '仅离线样例：不代表真实店铺操作或成功', requestId: record.request_id,
    shop: { id: record.identity.shop_id, region: record.identity.region }, object,
    responsibleActor: record.identity.principal_id, deadline: null, priority: null,
    state: verified ? '已核实' : unknown ? '结果待核' : '需要确认',
    nextAction: verified ? '样例流程已核实；真实上线仍须另行授权和独立验收'
      : unknown ? '只读核对原样例请求与对象，保留 UNKNOWN，禁止重新领取或发送'
        : approved ? '领取一次样例执行权，再由测试程序模拟发送' : '由已配置审批人核对准确对象、数量、金额与意图哈希',
    sourceTime: record.updated_at ?? null,
    evidence: record.evidence_ref ? [{ ref: record.evidence_ref, sha256: record.evidence_sha256, observedAt: record.observed_at }] : [],
    missingEvidence: verified ? [] : unknown ? ['原请求和意图的一致、有效、最新 fixture 只读证据'] : approved ? ['一次性样例领取及 fixture 只读证据'] : ['准确意图的 fixture_only 业务审批', '一次性样例领取及 fixture 只读证据']
  });
}
