"""Record the verified review stage without replacing unknown financial inputs."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import json, hashlib

ROOT = Path(__file__).resolve().parent.parent
RUN = ROOT / 'operations/controller/2026-10-12'
OUT = ROOT / 'outputs/pricing-review-2026-10-12'

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    assert 9 <= now.hour < 23, 'Outside working hours'
    at = now.isoformat()
    cloud = read(OUT / 'cloud-review-verification.json')
    assert cloud['full_value_and_formula_readback'] and cloud['baseline_values_and_formulas_preserved']
    assert all(c['passed'] for c in cloud['calculation_checks'])
    audit = read(OUT / 'original-formula-audit.json')
    append = read(OUT / 'four-products-append-plan.json')
    my = read(OUT / 'my-official-review.json')
    other = read(OUT / 'sg-vn-official-review.json')
    sync = read(OUT / 'skill-sync-verification.json')
    assert sync['reference_link_valid'] and all(x['synchronized'] for x in sync['files'])
    assert all(sha(Path(x['source'])) == x['sha256'] == sha(Path(x['installed'])) for x in sync['files'])
    assert audit['source_unchanged'] and audit['independent_checks_passed']
    assert len(audit['independent_checks']) == 30 and append['checks_passed'] and len(append['independent_pricing_checks']) == 48
    report_names = ['my-official-review.json', 'sg-vn-official-review.json', 'original-formula-audit.json',
                    'contribution-model-draft.json', 'four-products-append-plan.json', 'cloud-review-verification.json',
                    'skill-sync-verification.json']
    report_hashes = [{'path': str((OUT / n).relative_to(ROOT)).replace('\\', '/'), 'sha256': sha(OUT / n)} for n in report_names]
    status = 'official_first_pass_formula_audit_cloud_review_verified_real_inputs_pending'
    missing = ['MY中国跨境类目佣金及两店计划/豁免状态', 'MY/SG/VN现行中国内地直邮价卡及计费重量',
               'MY两店真实订单原价/券/手续费/退款/净结算对账', '采购、外部物流和仓库、广告实际账单',
               '实际汇率、Codex扣款及MY两店固定费用分摊', 'SG/VN跨境范围及VN退款冲突',
               '四新品12个准确平台SKU ID及price_id绑定', '其它成员访问权限']
    receipt = {'schema_version': 1, 'task_id': 'CTRL-20261012-PRICE-001', 'action_key': 'CTRL-20261012-PRICE-001',
        'owner_module': 'operating_control', 'owner_thread_id': '00000000-0000-4000-8000-000000000001',
        'observed_at_with_timezone': at, 'status': status, 'task_complete': False,
        'completed': ['26条官方来源记录及22条规则首轮复核，待核和未来单列', '原公式引用解释及30项独立算术复算',
                      '48项新品追加候选算术复算；原XLSX哈希未变', '三张云端复核/结算模板全值公式及计算结果回读',
                      '五个基线表元数据和完整值/公式前后摘要一致', '验证方法备份并同步项目及安装Skill'],
        'policy_record_counts': {'MY_sources': len(my['sources']), 'MY_rules': len(my['rules']),
                                 'SG_VN_sources': len(other['sources']), 'SG_VN_rules': len(other['rules'])},
        'verification_methods': {'original_formula_arithmetic_checks': 30, 'append_candidate_arithmetic_checks': 48,
                                 'entire_workbook_Excel_recalculation': False, 'real_order_profit': False},
        'cloud_review': cloud, 'evidence_hashes': report_hashes,
        'current_official_fees_fully_verified': False, 'current_fee_parameters_activated': False,
        'actual_month_profit_cny': None, 'profit_target_satisfied': None, 'shop_price_mutations': 0,
        'actual_spend_and_currency': {'new_FastMoss_paid_calls': 0, 'new_procurement_or_ad_spend': 0,
                                      'Feishu_API_billing_verified': False},
        'missing': missing, 'next_action': '既有ADS任务获浏览器grant后取MY净结算/优惠/佣金样本；据真实收费逐项激活参数并复核代表SKU，不重建表或整轮研究。',
        'skill_sync': sync, 'student_distribution_ready': False,
        'future_review_events': [{'key': 'MY_PayLater_20261016', 'not_before': '2026-10-16T09:00:00+08:00',
                                  'policy_effective_at': '2026-10-16T00:00:00+08:00', 'rate_pct': '4.86',
                                  'other_payments_pct': '3.78', 'status': 'policy_confirmed_actual_payment_and_bill_branch_pending'}]}
    paths = [RUN / n for n in ['task-board.json', 'adopted-rules.json', 'monitor-state.json', 'profit-baseline.json']]
    paths += [RUN / 'tasks/CTRL-20261012-PRICE-001.json', ROOT / 'operations/controller/latest.json',
              ROOT / 'operations/module-registry.json', ROOT / 'pricing/cloud-pricing-pointer.json']
    originals = {p: p.read_bytes() for p in paths}
    data = {p: read(p) for p in paths}
    board, rules, monitor, profit = [data[RUN / n] for n in ['task-board.json', 'adopted-rules.json', 'monitor-state.json', 'profit-baseline.json']]
    task = data[RUN / 'tasks/CTRL-20261012-PRICE-001.json']
    latest = data[ROOT / 'operations/controller/latest.json']
    registry = data[ROOT / 'operations/module-registry.json']
    pointer = data[ROOT / 'pricing/cloud-pricing-pointer.json']
    for item in [task, *[t for t in board['tasks'] if t['task_id'] == receipt['task_id']]]:
        item.update(status=status, updated_at=at, unknowns=missing, task_complete=False)
        item['scope'] = ['理解原表引用与实际成本', '复核MY/SG/VN中国跨境政策，MY优先', '旧版与新模型并行核验', '按用户指定buddy身份增补既有飞书表并独立回读']
        item['completed_stage'].update(official_first_pass=True, original_formula_arithmetic_verified=True,
                                      cloud_review_template_verified=True, full_current_parameters_activated=False)
        item['review_receipt'] = 'operations/controller/2026-10-12/receipts/CTRL-20261012-PRICE-001.json'
    assert len(board['tasks']) >= 9
    for obj in [rules['pricing_review'], registry['current_controller']['pricing_review']]:
        obj.update(review_status=status, first_pass_receipt=task['review_receipt'], current_official_fees_fully_verified=False,
                   current_fee_parameters_activated=False, future_review_events=receipt['future_review_events'])
    pointer['review'] = {'status': status, 'checked_at': at, 'sheet_ids': cloud['sheet_ids'],
                         'verification': 'outputs/pricing-review-2026-10-12/cloud-review-verification.json',
                         'receipt': task['review_receipt'], 'missing': missing, 'future_review_events': receipt['future_review_events']}
    pointer.update(current_official_fees_verified=False, official_rate_review_pending=True, updated_at=at)
    latest['pricing_review_receipt'] = task['review_receipt']
    latest['updated_at'] = at
    ads_module = next(m for m in registry['modules'] if m['module'] == 'ads')
    ads_module['automation_config_read'] = 'ACTIVE; Beijing09/11/13/15/17/19/21 verified; other safety gates retained'
    profit['pricing_review_receipt'] = task['review_receipt']
    assert all(profit[k] is None for k in ['settled_actual_operating_profit_cny', 'unsettled_estimated_profit_cny', 'cash_flow_cny', 'inventory_capital_cny'])
    monitor.update(processed_at=at, last_morning_review=task['review_receipt'])
    monitor['completed_cloud_stage'].update(review_template_evidence=pointer['review']['verification'], current_official_fees_verified=False)
    for h in monitor.get('pending_module_handoffs', []):
        if h['task_id'] == 'CTRL-20261012-PRO-003':
            h.update(status='trusted_user_authorization_verified_queued_after_CS_ADS', authorization_evidence='operations/controller/2026-10-12/morning-authorization-evidence.json')
    monitor['future_review_events'] = receipt['future_review_events']
    monitor['notes'] = '本轮官方首复核、原算法审计及线上模板已验；真实费用/物流/结算待既有模块回执。保留所有游标和未知财务值；无变化静默。'
    for obj in [board, rules, registry, profit]: obj['updated_at'] = at
    backup = ROOT / 'backups' / ('pricing-review-controller-' + now.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True)
    for path, raw in originals.items():
        assert path.read_bytes() == raw, 'Concurrent controller edit: ' + str(path)
        rel = path.relative_to(ROOT); dst = backup / rel; dst.parent.mkdir(parents=True, exist_ok=True); dst.write_bytes(raw)
    receipt['controller_backup'] = str(backup.relative_to(ROOT)).replace('\\', '/')
    receipt_path = RUN / 'receipts/CTRL-20261012-PRICE-001.json'
    receipt_path.write_bytes(encoded(receipt))
    for p in paths:
        if p.name != 'monitor-state.json': p.write_bytes(encoded(data[p]))
    consumed = [receipt_path, ROOT / 'operations/module-registry.json', ROOT / 'pricing/cloud-pricing-pointer.json']
    consumed += [OUT / n for n in report_names]
    for p in consumed:
        monitor['files_processed'][str(p.relative_to(ROOT)).replace('\\', '/')] = {'exists': True, 'sha256': sha(p)}
    (RUN / 'monitor-state.json').write_bytes(encoded(monitor))
    print(json.dumps({'status': status, 'task_complete': False, 'receipt': str(receipt_path), 'backup': str(backup),
                      'current_official_fees_fully_verified': False, 'actual_month_profit_cny': None}, ensure_ascii=True))

if __name__ == '__main__': main()
