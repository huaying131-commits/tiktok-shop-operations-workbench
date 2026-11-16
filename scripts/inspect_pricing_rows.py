import json
import re
from pathlib import Path

data = json.loads(Path('outputs/research-2026-10-03/pricing-extracted.json').read_text(encoding='utf-8'))
for name, rows in [('马来（跨境）老店+新店', [144, 152]), ('马来跨10（跨境）', [6, 7])]:
    s = next(s for s in data['sheets'] if s['name'] == name)
    print(name)
    for c in s['cells']:
        if int(re.sub('[A-Z]', '', c['cell'])) in rows:
            print(c['cell'], c['value'], '=', c['formula'] or c['formula_attrs'] or '')
