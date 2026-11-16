"""Publish a reviewed version into existing Feishu workbook; preserve baseline tabs."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import json, subprocess, hashlib

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'outputs/pricing-review-2026-10-12'
POINTER = json.loads((ROOT / 'pricing/cloud-pricing-pointer.json').read_text(encoding='utf-8-sig'))
TOKEN = POINTER['spreadsheet_token']
NODE = r'C:\Users\Operator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
CLI = r'C:\Users\Operator\AppData\Roaming\npm\node_modules\@larksuite\cli\scripts\run.js'
PAYLOAD = json.loads((OUT / 'cloud-review-payload.json').read_text(encoding='utf-8'))
STATE_PATH = OUT / 'cloud-review-checkpoint.json'
STATE = json.loads(STATE_PATH.read_text(encoding='utf-8')) if STATE_PATH.exists() else {'sheets': {}, 'completed': {}}

def gate():
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    if not 9 <= now.hour < 23:
        raise RuntimeError('Outside authorized work hours; checkpoint retained')
    return now.isoformat()

def save():
    STATE['updated_at'] = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()
    STATE_PATH.write_text(json.dumps(STATE, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def call(args, body=None, label=None):
    gate()
    p = subprocess.run([NODE, CLI, *args, '--as', 'bot'], input=json.dumps(body, ensure_ascii=False) if body is not None else None,
                       text=True, encoding='utf-8', capture_output=True, timeout=50)
    raw = p.stdout if '{' in p.stdout else p.stderr
    result = json.loads(raw[raw.index('{'):])
    if p.returncode or result.get('ok') is False or result.get('code', 0):
        raise RuntimeError(json.dumps(result, ensure_ascii=True))
    if label:
        (OUT / (label + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result

def api(method, suffix, body, label=None):
    return call(['api', method, '/open-apis/sheets/v2/spreadsheets/' + TOKEN + suffix, '--data', '-'], body, label)

def col(n):
    s = ''
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

def read(sid, area, render='Formula', label=None):
    r = call(['sheets', '+read', '--spreadsheet-token', TOKEN, '--sheet-id', sid, '--range', area,
              '--value-render-option', render], label=label)
    data = r['data']
    if 'valueRange' not in data and isinstance(data.get('data'), dict):
        data = data['data']
    return data['valueRange']['values']

def normalized(values, rows, width):
    def cell(v):
        if isinstance(v, dict) and v.get('type') == 'formula':
            return v['text']
        if isinstance(v, list) and all(isinstance(p, dict) and p.get('type') in ['url', 'text'] for p in v):
            assert all(p.get('type') != 'url' or p.get('text') == p.get('link') for p in v), 'Hyperlink destination differs from source text'
            return ''.join(p.get('text', '') for p in v)
        return '' if v is None else v
    return [[cell(values[i][j]) if i < len(values) and j < len(values[i]) else '' for j in range(width)] for i in range(rows)]

def digest(values):
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

def main():
    gate()
    info = call(['sheets', '+info', '--spreadsheet-token', TOKEN], label='review-cloud-before')
    before = info['data']['sheets']['sheets']
    baseline_ids = set(POINTER['sheet_ids'].values())
    baseline_titles = {s['title'] for s in before if s['sheet_id'] in baseline_ids}
    for key, sid in POINTER['sheet_ids'].items():
        assert any(s['sheet_id'] == sid for s in before), 'Baseline sheet missing: ' + key
    bytitle = {s['title']: s for s in before}
    assert len(bytitle) == len(before), 'Duplicate sheet title'
    assert len({s['title'] for s in PAYLOAD['sheets']}) == len(PAYLOAD['sheets']), 'Duplicate payload title'
    assert all(s['title'] not in baseline_titles for s in PAYLOAD['sheets']), 'Review cannot target baseline title'
    pending = STATE.get('pending')
    if pending and pending.get('action') == 'create_sheet':
        if pending['title'] not in bytitle:
            raise RuntimeError('Unresolved sheet creation; queried absent but outcome unknown. Do not resubmit: ' + pending['title'])
        STATE['resolved_prior_creation'] = pending; STATE['pending'] = None; save()
    baseline = {}
    for old in before:
        if old['sheet_id'] in baseline_ids:
            sid = old['sheet_id']
            rows, width = old['grid_properties']['row_count'], old['grid_properties']['column_count']
            area = 'A1:' + col(width) + str(rows)
            baseline[sid] = {'range': area, 'rows': rows, 'width': width,
                             'sha256': digest(normalized(read(sid, area, label='baseline-before-' + sid), rows, width))}
    (OUT / 'baseline-content-before.json').write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for sh in PAYLOAD['sheets']:
        title, values = sh['title'], sh['values']
        rows, width = len(values), max(map(len, values))
        area = 'A1:' + col(width) + str(rows)
        expected = normalized(values, rows, width)
        h = digest(expected)
        if title not in bytitle:
            STATE['pending'] = {'action': 'create_sheet', 'title': title, 'intent_at': gate()}; save()
            api('POST', '/sheets_batch_update', {'requests': [{'addSheet': {'properties': {'title': title}}}]}, label='create-' + sh['key'])
            fresh = call(['sheets', '+info', '--spreadsheet-token', TOKEN])
            fresh_sheets = fresh['data']['sheets']['sheets']
            bytitle = {s['title']: s for s in fresh_sheets}
            assert len(bytitle) == len(fresh_sheets), 'Duplicate sheet title after create'
        sid = bytitle[title]['sheet_id']
        assert sid not in baseline_ids and title not in baseline_titles, 'Review cannot target baseline sheet'
        grid = bytitle[title]['grid_properties']
        assert rows <= grid['row_count'] and width <= grid['column_count'], 'Review exceeds sheet capacity'
        STATE['sheets'][sh['key']] = sid; save()
        current = normalized(read(sid, area), rows, width)
        if current != expected:
            prior = STATE['completed'].get(sh['key'])
            if prior and prior != digest(current):
                raise RuntimeError('Concurrent or human content change in review sheet: ' + title)
            if not prior and any(v != '' for row in current for v in row):
                raise RuntimeError('Existing nonblank review sheet has a different version: ' + title)
            STATE['pending'] = {'action': 'write_values', 'sheet_id': sid, 'range': area, 'expected_digest': h, 'intent_at': gate()}; save()
            api('PUT', '/values', {'valueRange': {'range': sid + '!' + area, 'values': values}}, label='write-' + sh['key'])
            observed = normalized(read(sid, area, label='formula-readback-' + sh['key']), rows, width)
            assert observed == expected, 'Full value/formula readback mismatch: ' + title
        STATE['completed'][sh['key']] = h; STATE['pending'] = None; save()
        api('POST', '/sheets_batch_update', {'requests': [{'updateSheet': {'properties': {'sheetId': sid, 'frozenRowCount': 1}}}]})
    styles = [{'ranges': [STATE['sheets'][s['key']] + '!A1:' + col(max(map(len, s['values']))) + '1'],
               'style': {'font': {'bold': True}, 'backColor': '#243E58', 'foreColor': '#FFFFFF'}} for s in PAYLOAD['sheets']]
    call(['sheets', '+batch-set-style', '--spreadsheet-token', TOKEN, '--data', json.dumps(styles, ensure_ascii=False)], label='review-style-receipt')
    checks = []
    for case in PAYLOAD['checks']:
        observed = read(STATE['sheets'][case['sheet_key']], case['range'], 'UnformattedValue', label='check-' + case['name'])
        assert observed == case['expected'], 'Computed check mismatch: ' + case['name'] + str(observed)
        checks.append({'name': case['name'], 'range': case['range'], 'expected': case['expected'], 'observed': observed, 'passed': True})
    after = call(['sheets', '+info', '--spreadsheet-token', TOKEN], label='review-cloud-after')
    baseline_unchanged = all(next(s for s in after['data']['sheets']['sheets'] if s['sheet_id'] == old['sheet_id']) == old for old in before if old['sheet_id'] in baseline_ids)
    assert baseline_unchanged, 'Baseline metadata changed'
    for sid, snapshot in baseline.items():
        observed_hash = digest(normalized(read(sid, snapshot['range'], label='baseline-after-' + sid), snapshot['rows'], snapshot['width']))
        assert observed_hash == snapshot['sha256'], 'Baseline values/formulas changed: ' + sid
        snapshot['after_sha256'] = observed_hash; snapshot['passed'] = True
    receipt = {'task_id': 'CTRL-20261012-PRICE-001', 'observed_at': gate(), 'status': 'review_version_and_settlement_template_cloud_verified',
               'spreadsheet_url': POINTER['url'], 'sheet_ids': STATE['sheets'], 'full_value_and_formula_readback': True,
               'calculation_checks': checks, 'baseline_sheet_metadata_preserved': True, 'baseline_content_hashes': baseline,
               'baseline_values_and_formulas_preserved': True, 'source_reports': PAYLOAD['source_reports'],
               'current_official_fees_fully_verified': False, 'real_order_profit_computed': False,
               'source_cost_or_shop_prices_modified': False, 'paid_data_calls': 0, 'API_billing_verified': False}
    (OUT / 'cloud-review-verification.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    STATE['status'] = receipt['status']; save()
    print(json.dumps(receipt, ensure_ascii=True))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        STATE['status'] = 'unknown_or_failed_query_before_resubmission'
        STATE['last_error'] = str(exc); save()
        raise
