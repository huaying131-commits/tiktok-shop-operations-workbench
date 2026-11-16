"""Read only the two regional templates and their original logistics columns."""
import hashlib
import io
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from openpyxl.formula.translate import Translator

sys.stdout.reconfigure(encoding='utf-8')
project = Path(__file__).resolve().parent.parent
source = Path('C:/Users/Operator/Workspace/我的产品/codex自主运营tiktok店铺/【东南亚】玩具类目成本测算表 .xlsx')
output = project / 'outputs/flower-pilot-2026-10-03/M3080/pricing/sg-vn-source-extract.json'
names = ('越南（跨境）', '新加坡（跨境）', '物流价卡(更新时间1月27日）')
before = source.stat()
content = source.read_bytes()
after = source.stat()
if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
    raise RuntimeError('Source changed during reading.')
ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
sheets = []
with zipfile.ZipFile(io.BytesIO(content)) as archive:
    strings = [''.join(item.itertext()) for item in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
    targets = {item.attrib['Id']: item.attrib['Target'] for item in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
    workbook = ET.fromstring(archive.read('xl/workbook.xml'))
    for sheet in workbook.find('m:sheets', ns):
        name = sheet.attrib['name']
        if name not in names:
            continue
        target = targets[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
        xmlpath = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
        raw = ET.fromstring(archive.read(xmlpath))
        cells = []
        for cell in raw.findall('.//m:sheetData/m:row/m:c', ns):
            address = cell.attrib['r']
            selected = bool(re.match(r'^[JKMN]\d+$', address)) if name == names[2] else int(re.sub('[A-Z]', '', address)) <= 5
            if not selected:
                continue
            value_node, formula_node = cell.find('m:v', ns), cell.find('m:f', ns)
            value = value_node.text if value_node is not None else None
            if cell.get('t') == 's' and value is not None:
                value = strings[int(value)]
            inline = cell.find('m:is', ns)
            if inline is not None:
                value = ''.join(inline.itertext())
            if value is not None or formula_node is not None:
                cells.append({'cell': address, 'type': cell.get('t'), 'value': value,
                              'formula': formula_node.text if formula_node is not None else None,
                              'formula_attrs': dict(formula_node.attrib) if formula_node is not None else None})
        bases = {cell['formula_attrs']['si']: cell for cell in cells
                 if cell['formula_attrs'] and cell['formula_attrs'].get('t') == 'shared' and cell['formula']}
        for cell in cells:
            attrs = cell['formula_attrs'] or {}
            if attrs.get('t') == 'shared' and not cell['formula']:
                base = bases[attrs['si']]
                cell['formula'] = Translator('=' + base['formula'], origin=base['cell']).translate_formula(cell['cell'])[1:]
        sheets.append({'name': name, 'cells': cells})
if {sheet['name'] for sheet in sheets} != set(names):
    raise RuntimeError('Expected regional source sheets were not found.')
data = {'source': str(source), 'source_sha256': hashlib.sha256(content).hexdigest(), 'source_read_stable': True,
        'source_mtime_ns': after.st_mtime_ns, 'sheets': sheets, 'scope': 'SG/VN rows 1-5 and all logistics J:K / M:N'}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'source_sha256': data['source_sha256'], 'source_read_stable': True, 'output': str(output),
                  'sheets': [{'name': s['name'], 'cells': len(s['cells'])} for s in sheets],
                  'logistics_200g': [c for s in sheets if s['name'] == names[2] for c in s['cells'] if c['cell'] in ['J23','K23','M23','N23']]}, ensure_ascii=False))
