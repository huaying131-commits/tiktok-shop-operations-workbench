"""Read-only comparison of the audited pricing sample and its source workbook."""
import hashlib
import io
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

sys.stdout.reconfigure(encoding='utf-8')

project = Path(__file__).resolve().parent.parent
snapshot = json.loads((project / 'outputs/research-2026-10-03/pricing-extracted.json').read_text(encoding='utf-8'))
source = Path(snapshot['source'])
before = source.stat()
content = source.read_bytes()
after = source.stat()
if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
    raise RuntimeError('Source changed while reading; no comparison reported.')
ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
names = ('马来（跨境）老店+新店', '物流价卡(更新时间1月27日）')
differences = []
counts = {}
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
        def selected(address):
            return int(re.sub('[A-Z]', '', address)) <= 5 if name == names[0] else bool(re.match(r'^[DE]\d+$', address))
        actual = {}
        for cell in raw.findall('.//m:sheetData/m:row/m:c', ns):
            address = cell.attrib['r']
            if not selected(address):
                continue
            value_node, formula_node = cell.find('m:v', ns), cell.find('m:f', ns)
            value = value_node.text if value_node is not None else None
            if cell.get('t') == 's' and value is not None:
                value = strings[int(value)]
            inline = cell.find('m:is', ns)
            if inline is not None:
                value = ''.join(inline.itertext())
            if value is not None or formula_node is not None:
                actual[address] = {'value': value, 'formula': formula_node.text if formula_node is not None else None}
        previous = {cell['cell']: {'value': cell['value'], 'formula': cell['formula']}
                    for item in snapshot['sheets'] if item['name'] == name for cell in item['cells'] if selected(cell['cell'])}
        counts[name] = {'snapshot_cells': len(previous), 'current_cells': len(actual)}
        for address in sorted(previous.keys() | actual.keys()):
            if previous.get(address) != actual.get(address):
                differences.append({'sheet': name, 'cell': address, 'snapshot': previous.get(address), 'current': actual.get(address)})
print(json.dumps({'source_sha256': hashlib.sha256(content).hexdigest(), 'source_read_stable': True,
                  'source_mtime_ns': after.st_mtime_ns, 'counts': counts, 'differences': differences}, ensure_ascii=False))
